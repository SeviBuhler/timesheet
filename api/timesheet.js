import { Redis } from "@upstash/redis";

/* Liest die Zugangsdaten aus den Env-Variablen.
 * Die Vercel-Marketplace-Integration (Upstash Redis) spritzt sie automatisch ein.
 * Je nach Integration heissen sie KV_* oder UPSTASH_* – wir decken beide ab. */
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USERS_KEY = "timesheet:users";
const slotsKey = (id) => `timesheet:slots:${id}`;

export default async function handler(req, res) {
  try {
    /* ---- LESEN: alle Personen + ihre Slots ---- */
    if (req.method === "GET") {
      const users = (await redis.get(USERS_KEY)) || [];
      const slotsByUser = {};
      for (const u of users) {
        slotsByUser[u.id] = (await redis.get(slotsKey(u.id))) || [];
      }
      return res.status(200).json({ users, slotsByUser });
    }

    /* ---- SCHREIBEN ---- */
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const { action } = body;

      // Neue Person anlegen (server-seitig anhängen → kein Überschreiben)
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

      // Slots einer einzelnen Person speichern (nur die eigenen!)
      if (action === "setUserSlots") {
        if (!body.userId) return res.status(400).json({ error: "userId fehlt" });
        await redis.set(slotsKey(body.userId), Array.isArray(body.slots) ? body.slots : []);
        return res.status(200).json({ ok: true });
      }

      // Person entfernen (+ ihre Slots löschen)
      if (action === "removeUser") {
        if (!body.userId) return res.status(400).json({ error: "userId fehlt" });
        const users = (await redis.get(USERS_KEY)) || [];
        await redis.set(USERS_KEY, users.filter((u) => u.id !== body.userId));
        await redis.del(slotsKey(body.userId));
        return res.status(200).json({ ok: true });
      }

      // Alles zurücksetzen
      if (action === "reset") {
        const users = (await redis.get(USERS_KEY)) || [];
        for (const u of users) await redis.del(slotsKey(u.id));
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