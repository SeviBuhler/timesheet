import React, { useState, useEffect, useRef, useCallback } from "react";
import { Plus, X, Check, Trash2, Users, Clock, MousePointerClick, Lock, RefreshCw } from "lucide-react";

/* ------------------------------------------------------------------ *
 *  KONFIGURATION  – hier alles anpassbar
 * ------------------------------------------------------------------ */
const DAYS = [
  { date: "2026-06-25", wd: "Do", dm: "25.06." },
  { date: "2026-06-26", wd: "Fr", dm: "26.06." },
  { date: "2026-06-27", wd: "Sa", dm: "27.06." },
  { date: "2026-06-28", wd: "So", dm: "28.06." },
];
const START_HOUR = 8;     // Tag beginnt um …
const END_HOUR = 22;      // … und endet um
const SLOT_MINUTES = 30;  // Slot-Länge: 60 = 1 h, 30 = halbe Stunde, 15 = Viertelstunde
const TARGET_HOURS = 9;   // Soll pro Person (in Stunden)
const MAX_PER_SLOT = 2;   // max. Personen gleichzeitig
const MAX_USERS = 4;

const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899"];

/* Slots als Minuten-ab-Mitternacht, z. B. 480 = 08:00, 510 = 08:30 */
const DAY_START = START_HOUR * 60;
const DAY_END = END_HOUR * 60;
const SLOTS = [];
for (let m = DAY_START; m < DAY_END; m += SLOT_MINUTES) SLOTS.push(m);
const SLOT_HOURS = SLOT_MINUTES / 60; // Wert eines Slots in Stunden

const pad = (n) => String(n).padStart(2, "0");
const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const fmtH = (h) => (Number.isInteger(h) ? String(h) : h.toFixed(1));
const slotKey = (date, m) => `${date}|${m}`;
const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "u" + Date.now() + Math.random().toString(36).slice(2, 7);

/* ------------------------------------------------------------------ *
 *  STORAGE  – spricht die Serverless-Function /api/timesheet an.
 *  Server-Datenmodell: 1 Key pro Person → niemand überschreibt den
 *  anderen. Hier merged zu { slots: { "date|min": [userIds] } }.
 * ------------------------------------------------------------------ */
const API = "/api/timesheet";

async function api(method, body) {
  const res = await fetch(API, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("api " + res.status);
  return res.json();
}

const store = {
  async load() {
    try {
      const { users, slotsByUser } = await api("GET");
      const slots = {};
      for (const [id, arr] of Object.entries(slotsByUser || {})) {
        for (const k of arr) (slots[k] = slots[k] || []).push(id);
      }
      return { users: users || [], slots };
    } catch (e) {
      console.warn("load fehlgeschlagen – nur im Speicher", e);
      return null;
    }
  },
  async addUser(user) {
    try { await api("POST", { action: "addUser", user }); } catch (e) { console.error(e); }
  },
  async saveUserSlots(userId, slots) {
    try { await api("POST", { action: "setUserSlots", userId, slots }); } catch (e) { console.error(e); }
  },
  async removeUser(userId) {
    try { await api("POST", { action: "removeUser", userId }); } catch (e) { console.error(e); }
  },
  async reset() {
    try { await api("POST", { action: "reset" }); } catch (e) { console.error(e); }
  },
};

/* Welche Person bin ich auf DIESEM Gerät? → localStorage (pro Gerät) */
const meStore = {
  load() { try { return localStorage.getItem("timesheet-me"); } catch { return null; } },
  save(id) {
    try { id ? localStorage.setItem("timesheet-me", id) : localStorage.removeItem("timesheet-me"); }
    catch (_) {}
  },
};

/* ================================================================== */
export default function Timesheet() {
  const [data, setData] = useState({ users: [], slots: {} });
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState(null);

  const [name, setName] = useState("");
  const [mDay, setMDay] = useState(DAYS[0].date);
  const [mVon, setMVon] = useState(DAY_START);
  const [mBis, setMBis] = useState(DAY_START + TARGET_HOURS * 60);

  const dataRef = useRef(data);
  const meRef = useRef(me);
  const painting = useRef(false);
  const paintAdd = useRef(true);
  const slotTimer = useRef(null);
  const pendingSlots = useRef(null);
  const msgTimer = useRef(null);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { meRef.current = me; }, [me]);

  const flash = useCallback((text) => {
    setMsg(text);
    clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(null), 2600);
  }, []);

  /* ---- Speichern der eigenen Slots (debounced) ---- */
  const myKeys = (d, id) => Object.keys(d.slots).filter((k) => d.slots[k].includes(id));
  const flushSlots = useCallback(async () => {
    clearTimeout(slotTimer.current);
    const p = pendingSlots.current;
    pendingSlots.current = null;
    if (p) await store.saveUserSlots(p.userId, p.keys);
  }, []);
  const scheduleSaveSlots = useCallback((userId, next) => {
    pendingSlots.current = { userId, keys: myKeys(next, userId) };
    clearTimeout(slotTimer.current);
    slotTimer.current = setTimeout(flushSlots, 350);
  }, [flushSlots]);

  const mutate = useCallback((fn, onCommit) => {
    setData((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      dataRef.current = next;
      if (onCommit) onCommit(next);
      return next;
    });
  }, []);

  /* ---- Laden / Aktualisieren ---- */
  const refresh = useCallback(async () => {
    setSyncing(true);
    await flushSlots();
    const d = await store.load();
    if (d) {
      setData(d);
      dataRef.current = d;
      const m = meRef.current;
      if (m && !d.users.some((u) => u.id === m)) { setMe(null); meStore.save(null); }
    }
    setSyncing(false);
  }, [flushSlots]);

  useEffect(() => {
    (async () => {
      const d = await store.load();
      if (d) { setData(d); dataRef.current = d; }
      const m = meStore.load();
      if (m && d && d.users.some((u) => u.id === m)) setMe(m);
      setLoading(false);
    })();
  }, []);

  // Beim Zurückkehren ins Tab: frische Daten der anderen holen
  useEffect(() => {
    const onFocus = () => { if (!painting.current) refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const occ = (d, date, m) => d.slots[slotKey(date, m)] || [];
  const userHours = (d, id) =>
    Object.values(d.slots).reduce((acc, arr) => acc + (arr.includes(id) ? SLOT_HOURS : 0), 0);

  /* ---- Benutzer ---- */
  const createUser = () => {
    const n = name.trim();
    if (!n) return;
    if (data.users.length >= MAX_USERS) return flash(`Maximal ${MAX_USERS} Personen.`);
    if (data.users.some((u) => u.name.toLowerCase() === n.toLowerCase()))
      return flash("Name existiert bereits.");
    const id = uid();
    const color = COLORS[data.users.length % COLORS.length];
    const user = { id, name: n, color };
    mutate((prev) => ({ ...prev, users: [...prev.users, user] }));
    store.addUser(user);
    setName("");
    setMe(id);
    meStore.save(id);
  };

  const selectMe = (id) => { setMe(id); meStore.save(id); };

  const removeUser = (id) => {
    mutate((prev) => {
      const slots = {};
      for (const [k, arr] of Object.entries(prev.slots)) {
        const f = arr.filter((x) => x !== id);
        if (f.length) slots[k] = f;
      }
      return { users: prev.users.filter((u) => u.id !== id), slots };
    });
    store.removeUser(id);
    if (me === id) { setMe(null); meStore.save(null); }
  };

  const resetAll = () => {
    if (!window.confirm("Wirklich alle Einträge und Personen löschen?")) return;
    const empty = { users: [], slots: {} };
    setData(empty); dataRef.current = empty;
    store.reset();
    setMe(null); meStore.save(null);
  };

  /* ---- Slot setzen ---- */
  const applyPaint = useCallback((date, m) => {
    const id = meRef.current;
    if (!id) return;
    mutate(
      (prev) => {
        const k = slotKey(date, m);
        const arr = prev.slots[k] ? [...prev.slots[k]] : [];
        const has = arr.includes(id);
        if (paintAdd.current) {
          if (has) return prev;
          if (arr.length >= MAX_PER_SLOT) { flash(`Slot voll – max. ${MAX_PER_SLOT} gleichzeitig.`); return prev; }
          arr.push(id);
        } else {
          if (!has) return prev;
          arr.splice(arr.indexOf(id), 1);
        }
        const slots = { ...prev.slots };
        if (arr.length) slots[k] = arr; else delete slots[k];
        return { ...prev, slots };
      },
      (next) => scheduleSaveSlots(id, next)
    );
  }, [mutate, flash, scheduleSaveSlots]);

  /* ---- Zeigen/Ziehen (Maus + Touch) ---- */
  const onCellDown = (e, date, m) => {
    if (!meRef.current) { flash("Wähle oben zuerst, wer du bist."); return; }
    e.preventDefault();
    const has = occ(dataRef.current, date, m).includes(meRef.current);
    paintAdd.current = !has;
    painting.current = true;
    applyPaint(date, m);
  };
  const onGridMove = (e) => {
    if (!painting.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest("[data-cell]");
    if (cell) applyPaint(cell.dataset.date, Number(cell.dataset.min));
  };
  useEffect(() => {
    const up = () => { painting.current = false; };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  /* ---- Manuelle Eingabe ---- */
  const manual = (add) => {
    if (!me) return flash("Wähle oben zuerst, wer du bist.");
    if (mVon >= mBis) return flash("„Von“ muss kleiner als „Bis“ sein.");
    let done = 0, skip = 0;
    mutate(
      (prev) => {
        const slots = { ...prev.slots };
        for (let m = mVon; m < mBis; m += SLOT_MINUTES) {
          const k = slotKey(mDay, m);
          const arr = slots[k] ? [...slots[k]] : [];
          const has = arr.includes(me);
          if (add) {
            if (has) continue;
            if (arr.length >= MAX_PER_SLOT) { skip++; continue; }
            arr.push(me); done++;
          } else {
            if (!has) continue;
            arr.splice(arr.indexOf(me), 1); done++;
          }
          if (arr.length) slots[k] = arr; else delete slots[k];
        }
        return { ...prev, slots };
      },
      (next) => scheduleSaveSlots(me, next)
    );
    const doneH = fmtH(done * SLOT_HOURS);
    const skipH = fmtH(skip * SLOT_HOURS);
    flash(add
      ? `${doneH} h eingetragen${skip ? `, ${skipH} h übersprungen (voll)` : ""}.`
      : `${doneH} h ausgetragen.`);
  };

  /* ---------------------------------------------------------------- */
  if (loading)
    return <div className="p-10 text-center text-slate-400 font-mono text-sm">lädt …</div>;

  const meUser = data.users.find((u) => u.id === me);
  const allDone = data.users.length > 0 && data.users.every((u) => userHours(data, u.id) >= TARGET_HOURS);

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-800 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-3xl">
        {/* Kopf */}
        <header className="mb-5">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Schichtplan</h1>
            <button
              onClick={refresh}
              className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-500 hover:text-slate-900"
              title="Einträge der anderen neu laden"
            >
              <RefreshCw size={13} className={syncing ? "animate-spin" : ""} /> Aktualisieren
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-500">
            <span className="inline-flex items-center gap-1"><Clock size={13} /> Soll {TARGET_HOURS} h / Person</span>
            <span className="inline-flex items-center gap-1"><Users size={13} /> max. {MAX_PER_SLOT} gleichzeitig</span>
            <span className="inline-flex items-center gap-1"><MousePointerClick size={13} /> klicken &amp; ziehen</span>
            <span>25.–28.06.2026</span>
          </div>
        </header>

        {/* Personen */}
        <section className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Wer bist du?</h2>
            {meUser && (
              <span className="font-mono text-xs text-slate-500">
                aktiv: <b style={{ color: meUser.color }}>{meUser.name}</b>
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {data.users.map((u) => {
              const h = userHours(data, u.id);
              const pct = Math.min(100, (h / TARGET_HOURS) * 100);
              const reached = h >= TARGET_HOURS;
              const active = u.id === me;
              return (
                <div
                  key={u.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition ${
                    active ? "border-slate-800 bg-slate-50" : "border-slate-200"
                  }`}
                >
                  <button
                    onClick={() => selectMe(u.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title="Als aktive Person wählen"
                  >
                    <span
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
                      style={{ backgroundColor: u.color }}
                    >
                      {u.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="truncate text-sm font-medium">{u.name}</span>
                    {active && (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        das bist du
                      </span>
                    )}
                  </button>

                  <div className="hidden w-28 sm:block">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: reached ? "#10b981" : u.color }}
                      />
                    </div>
                  </div>

                  <span
                    className={`flex w-20 items-center justify-end gap-1 font-mono text-xs tabular-nums ${
                      reached ? "text-emerald-600" : "text-slate-500"
                    }`}
                  >
                    {reached && <Check size={13} />}
                    {fmtH(h)}/{TARGET_HOURS} h
                  </span>

                  <button
                    onClick={() => removeUser(u.id)}
                    className="text-slate-300 hover:text-rose-500"
                    title="Person entfernen"
                  >
                    <X size={15} />
                  </button>
                </div>
              );
            })}

            {data.users.length < MAX_USERS && (
              <div className="flex gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createUser()}
                  placeholder="Name eingeben …"
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-800"
                />
                <button
                  onClick={createUser}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
                >
                  <Plus size={15} /> Erstellen
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Raster */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
          <div
            className="select-none"
            onPointerMove={onGridMove}
            style={{ display: "grid", gridTemplateColumns: "54px repeat(4, 1fr)", gap: "4px" }}
          >
            <div />
            {DAYS.map((d) => (
              <div key={d.date} className="pb-1 text-center">
                <div className="text-sm font-semibold text-slate-900">{d.wd}</div>
                <div className="font-mono text-[11px] text-slate-400">{d.dm}</div>
              </div>
            ))}

            {SLOTS.map((m) => {
              const isHour = m % 60 === 0;
              return (
                <React.Fragment key={m}>
                  <div
                    className={`flex items-center justify-end pr-1 font-mono text-[11px] ${
                      isHour ? "text-slate-500" : "text-slate-300"
                    }`}
                  >
                    {fmt(m)}
                  </div>
                  {DAYS.map((d) => {
                    const arr = occ(data, d.date, m);
                    const mine = me && arr.includes(me);
                    const full = arr.length >= MAX_PER_SLOT && !mine;
                    return (
                      <div
                        key={d.date + m}
                        data-cell
                        data-date={d.date}
                        data-min={m}
                        onPointerDown={(e) => onCellDown(e, d.date, m)}
                        style={{ touchAction: "none", minHeight: 34 }}
                        className={`flex cursor-pointer items-center justify-center gap-1 rounded-md border transition ${
                          mine
                            ? "border-slate-800"
                            : full
                            ? "border-slate-200 bg-slate-100 cursor-not-allowed"
                            : "border-slate-150 bg-white hover:border-slate-300"
                        } ${isHour ? "" : "border-dashed"}`}
                      >
                        {arr.length === 0 ? (
                          <Plus size={12} className="text-slate-200" />
                        ) : (
                          arr.map((id) => {
                            const u = data.users.find((x) => x.id === id);
                            if (!u) return null;
                            return (
                              <span
                                key={id}
                                className="grid h-5 w-5 place-items-center rounded-full text-[9px] font-bold text-white"
                                style={{ backgroundColor: u.color }}
                                title={u.name}
                              >
                                {u.name.slice(0, 2).toUpperCase()}
                              </span>
                            );
                          })
                        )}
                        {full && <Lock size={9} className="text-slate-300" />}
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </section>

        {/* Manuelle Eingabe */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Manuell eintragen</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-slate-400">Tag</span>
              <select value={mDay} onChange={(e) => setMDay(e.target.value)}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-slate-800">
                {DAYS.map((d) => <option key={d.date} value={d.date}>{d.wd} {d.dm}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-slate-400">Von</span>
              <select value={mVon} onChange={(e) => setMVon(Number(e.target.value))}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono outline-none focus:border-slate-800">
                {SLOTS.map((m) => <option key={m} value={m}>{fmt(m)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-slate-400">Bis</span>
              <select value={mBis} onChange={(e) => setMBis(Number(e.target.value))}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono outline-none focus:border-slate-800">
                {SLOTS.map((m) => m + SLOT_MINUTES).map((m) => (
                  <option key={m} value={m}>{fmt(m)}</option>
                ))}
              </select>
            </label>
            <button onClick={() => manual(true)}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
              Eintragen
            </button>
            <button onClick={() => manual(false)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Austragen
            </button>
          </div>
        </section>

        {/* Fuss */}
        <div className="flex items-center justify-between">
          {allDone ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-emerald-600">
              <Check size={14} /> Alle haben ihr Soll erreicht
            </span>
          ) : (
            <span className="font-mono text-xs text-slate-400">
              Geteilter Plan · „Aktualisieren" zeigt die neuesten Einträge der anderen.
            </span>
          )}
          <button onClick={resetAll}
            className="inline-flex items-center gap-1 font-mono text-xs text-slate-400 hover:text-rose-500">
            <Trash2 size={13} /> Zurücksetzen
          </button>
        </div>
      </div>

      {/* Toast */}
      {msg && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {msg}
        </div>
      )}
    </div>
  );
}
