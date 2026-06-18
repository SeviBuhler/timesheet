import { Redis } from "@upstash/redis";

/* Zugangsdaten aus den Env-Variablen der Upstash-Integration.
 * Je nach Integration mit Präfix (Storage_) – wir decken die gängigen Namen ab. */
const redis = new Redis({
  url:
    process.env.Storage_KV_REST_API_URL ||
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL,
  token:
    process.env.Storage_KV_REST_API_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USERS_KEY = "timesheet:users";
const slotsKey = (id) => `timesheet:slots:${id}`;
const bookingsKey = (id) => `timesheet:bookings:${id}`; // Redis-Hash: feld = "date|min", wert = {name, phone}

export default async function handler(req, res) {
  try {
    /* ---- LESEN: Therapeuten + Schichten + Buchungen ---- */
    if (req.method === "GET") {
      const users = (await redis.get(USERS_KEY)) || [];
      const slotsByUser = {};
      const bookingsByTherapist = {};
      for (const u of users) {
        slotsByUser[u.id] = (await redis.get(slotsKey(u.id))) || [];
        bookingsByTherapist[u.id] = (await redis.hgetall(bookingsKey(u.id))) || {};
      }
      return res.status(200).json({ users, slotsByUser, bookingsByTherapist });
    }

    /* ---- SCHREIBEN ---- */
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const { action } = body;

      // Therapeut/Masseur anlegen
      if (action === "addUser") {
        const u = body.user;
        if (!u || !u.id || !u.name) return res.status(400).json({ error: "user fehlt" });
        const users = (await redis.get(USERS_KEY)) || [];
        const exists = users.some(
          (x) => x.id === u.id || x.name.toLowerCase() === u.name.toLowerCase()
        );
        if (!exists) {
          users.push(u);
          await redis.set(USERS_KEY, users);
        }
        return res.status(200).json({ users });
      }

      // Schicht-Slots eines Therapeuten speichern (nur die eigenen)
      if (action === "setUserSlots") {
        if (!body.userId) return res.status(400).json({ error: "userId fehlt" });
        await redis.set(slotsKey(body.userId), Array.isArray(body.slots) ? body.slots : []);
        return res.status(200).json({ ok: true });
      }

      // Patient bucht einen Slot bei einem Therapeuten (atomar gegen Doppelbuchung)
      if (action === "book") {
        const { therapistId, slotKey: sk, name, phone } = body;
        if (!therapistId || !sk || !name || !phone)
          return res.status(400).json({ error: "Angaben fehlen" });
        const shift = (await redis.get(slotsKey(therapistId))) || [];
        if (!shift.includes(sk))
          return res.status(400).json({ error: "Therapeut arbeitet zu dieser Zeit nicht" });
        // HSETNX = nur setzen, wenn das Feld noch nicht existiert → kein doppeltes Buchen
        const set = await redis.hsetnx(bookingsKey(therapistId), sk, { name, phone });
        if (set === 0) return res.status(409).json({ error: "Slot bereits gebucht" });
        return res.status(200).json({ ok: true });
      }

      // Buchung stornieren
      if (action === "cancelBooking") {
        const { therapistId, slotKey: sk } = body;
        if (!therapistId || !sk) return res.status(400).json({ error: "Angaben fehlen" });
        await redis.hdel(bookingsKey(therapistId), sk);
        return res.status(200).json({ ok: true });
      }

      // Therapeut entfernen (+ Schichten + Buchungen)
      if (action === "removeUser") {
        if (!body.userId) return res.status(400).json({ error: "userId fehlt" });
        const users = (await redis.get(USERS_KEY)) || [];
        await redis.set(USERS_KEY, users.filter((u) => u.id !== body.userId));
        await redis.del(slotsKey(body.userId));
        await redis.del(bookingsKey(body.userId));
        return res.status(200).json({ ok: true });
      }

      // Alles zurücksetzen
      if (action === "reset") {
        const users = (await redis.get(USERS_KEY)) || [];
        for (const u of users) {
          await redis.del(slotsKey(u.id));
          await redis.del(bookingsKey(u.id));
        }
        await redis.del(USERS_KEY);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "unbekannte action" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("timesheet api error", e);
    return res.status(500).json({ error: "server error" });
  }
}