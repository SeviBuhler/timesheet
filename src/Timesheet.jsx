import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, X, Check, Trash2, Users, Clock, MousePointerClick, Lock, RefreshCw,
  CalendarDays, HandHeart, Phone, AlertTriangle,
} from "lucide-react";

/* ------------------------------------------------------------------ *
 *  KONFIGURATION
 * ------------------------------------------------------------------ */
const DAYS = [
  { date: "2026-06-25", wd: "Do", dm: "25.06." },
  { date: "2026-06-26", wd: "Fr", dm: "26.06." },
  { date: "2026-06-27", wd: "Sa", dm: "27.06." },
  { date: "2026-06-28", wd: "So", dm: "28.06." },
];
const START_HOUR = 8;
const END_HOUR = 22;
const SLOT_MINUTES = 30;
const TARGET_HOURS = 9;
const MAX_PER_SLOT = 2;
const MAX_USERS = 4;
const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899"];

const DAY_START = START_HOUR * 60;
const DAY_END = END_HOUR * 60;
const SLOTS = [];
for (let m = DAY_START; m < DAY_END; m += SLOT_MINUTES) SLOTS.push(m);
const SLOT_HOURS = SLOT_MINUTES / 60;

const pad = (n) => String(n).padStart(2, "0");
const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const fmtH = (h) => (Number.isInteger(h) ? String(h) : h.toFixed(1));
const slotKey = (date, m) => `${date}|${m}`;
const dayLabel = (date) => { const d = DAYS.find((x) => x.date === date); return d ? `${d.wd} ${d.dm}` : date; };
const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "u" + Date.now() + Math.random().toString(36).slice(2, 7);
const GRID_COLS = "54px repeat(4, 1fr)";

/* Telefon: nur Ziffern, optional ein führendes + */
const sanitizePhone = (v) => {
  const plus = v.trimStart().startsWith("+");
  const digits = v.replace(/\D/g, "");
  return (plus ? "+" : "") + digits;
};
const phoneValid = (v) => /^\+?\d{7,}$/.test(v);

/* ------------------------------------------------------------------ *
 *  STORAGE  – /api/timesheet (Upstash Redis)
 * ------------------------------------------------------------------ */
const API = "/api/timesheet";
async function post(body) {
  return fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const store = {
  async load() {
    try {
      const res = await fetch(API);
      if (!res.ok) throw new Error("api " + res.status);
      const { users, slotsByUser, bookingsByTherapist } = await res.json();
      const slots = {};
      for (const [id, arr] of Object.entries(slotsByUser || {}))
        for (const k of arr) (slots[k] = slots[k] || []).push(id);
      return { users: users || [], slots, bookings: bookingsByTherapist || {} };
    } catch (e) { console.warn("load fehlgeschlagen – nur im Speicher", e); return null; }
  },
  async addUser(user) { try { await post({ action: "addUser", user }); } catch (e) { console.error(e); } },
  async saveUserSlots(userId, slots) { try { await post({ action: "setUserSlots", userId, slots }); } catch (e) { console.error(e); } },
  async removeUser(userId) { try { await post({ action: "removeUser", userId }); } catch (e) { console.error(e); } },
  async reset() { try { await post({ action: "reset" }); } catch (e) { console.error(e); } },
  async book(therapistId, sk, name, phone) {
    try {
      const res = await post({ action: "book", therapistId, slotKey: sk, name, phone });
      if (res.status === 200) return { ok: true };
      if (res.status === 409) return { ok: false, reason: "conflict" };
      return { ok: false, reason: "error" };
    } catch { return { ok: false, reason: "error" }; }
  },
  async cancelBooking(therapistId, sk) { try { await post({ action: "cancelBooking", therapistId, slotKey: sk }); } catch (e) { console.error(e); } },
};
const meStore = {
  load() { try { return localStorage.getItem("timesheet-me"); } catch { return null; } },
  save(id) { try { id ? localStorage.setItem("timesheet-me", id) : localStorage.removeItem("timesheet-me"); } catch (_) {} },
};
const getPageFromHash = () => (location.hash === "#schichten" ? "shifts" : "book");

/* ================================================================== */
export default function App() {
  const [data, setData] = useState({ users: [], slots: {}, bookings: {} });
  const [me, setMe] = useState(null);
  const [page, setPage] = useState(getPageFromHash());
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState(null);

  const dataRef = useRef(data);
  const meRef = useRef(me);
  const msgTimer = useRef(null);
  const editingRef = useRef(false);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { meRef.current = me; }, [me]);
  const handleEditingChange = useCallback((editing) => { editingRef.current = editing; }, []);

  const flash = useCallback((text) => {
    setMsg(text);
    clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(null), 2800);
  }, []);

  useEffect(() => {
    const onHash = () => setPage(getPageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (p) => { location.hash = p === "shifts" ? "#schichten" : "#buchen"; setPage(p); };

  const mutate = useCallback((fn, onCommit) => {
    setData((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      dataRef.current = next;
      if (onCommit) onCommit(next);
      return next;
    });
  }, []);

  const saveUserSlots = useCallback(async (userId, nextKeys, removedBookedKeys = []) => {
    for (const k of removedBookedKeys) await store.cancelBooking(userId, k);
    mutate((prev) => {
      const slots = {};
      for (const [k, arr] of Object.entries(prev.slots)) {
        const filtered = arr.filter((x) => x !== userId);
        if (filtered.length) slots[k] = filtered;
      }
      for (const k of nextKeys) {
        const arr = slots[k] ? [...slots[k]] : [];
        if (!arr.includes(userId)) arr.push(userId);
        slots[k] = arr;
      }
      const bookings = { ...(prev.bookings || {}) };
      if (removedBookedKeys.length && bookings[userId]) {
        const nextBookings = { ...bookings[userId] };
        for (const k of removedBookedKeys) delete nextBookings[k];
        if (Object.keys(nextBookings).length) bookings[userId] = nextBookings;
        else delete bookings[userId];
      }
      return { ...prev, slots, bookings };
    });
    await store.saveUserSlots(userId, nextKeys);
  }, [mutate]);

  const refresh = useCallback(async () => {
    if (editingRef.current) {
      flash("Bitte zuerst speichern oder abbrechen.");
      return;
    }
    setSyncing(true);
    const d = await store.load();
    if (d) {
      setData(d); dataRef.current = d;
      const m = meRef.current;
      if (m && !d.users.some((u) => u.id === m)) { setMe(null); meStore.save(null); }
    }
    setSyncing(false);
  }, [flash]);

  useEffect(() => {
    (async () => {
      const d = await store.load();
      if (d) { setData(d); dataRef.current = d; }
      const m = meStore.load();
      if (m && d && d.users.some((u) => u.id === m)) setMe(m);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    const onFocus = () => { if (!editingRef.current) refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const userHours = (d, id) =>
    Object.values(d.slots).reduce((acc, arr) => acc + (arr.includes(id) ? SLOT_HOURS : 0), 0);
  const isBooked = (d, id, k) => !!(d.bookings && d.bookings[id] && d.bookings[id][k]);

  /* ---- Therapeuten ---- */
  const createUser = (rawName) => {
    const n = (rawName || "").trim();
    if (!n) return;
    if (data.users.length >= MAX_USERS) return flash(`Maximal ${MAX_USERS} Personen.`);
    if (data.users.some((u) => u.name.toLowerCase() === n.toLowerCase())) return flash("Name existiert bereits.");
    const id = uid();
    const user = { id, name: n, color: COLORS[data.users.length % COLORS.length] };
    mutate((prev) => ({ ...prev, users: [...prev.users, user] }));
    store.addUser(user);
    setMe(id); meStore.save(id);
  };
  const selectMe = (id) => { setMe(id); meStore.save(id); };
  const removeUser = (id) => {
    const u = data.users.find((x) => x.id === id);
    const cnt = data.bookings?.[id] ? Object.keys(data.bookings[id]).length : 0;
    const warn = cnt ? `\n\nAchtung: ${cnt} bestehende Buchung(en) werden mitgelöscht.` : "";
    if (!window.confirm(`Person „${u?.name}" entfernen?${warn}`)) return;
    mutate((prev) => {
      const slots = {};
      for (const [k, arr] of Object.entries(prev.slots)) {
        const f = arr.filter((x) => x !== id);
        if (f.length) slots[k] = f;
      }
      const bookings = { ...(prev.bookings || {}) };
      delete bookings[id];
      return { users: prev.users.filter((u2) => u2.id !== id), slots, bookings };
    });
    store.removeUser(id);
    if (me === id) { setMe(null); meStore.save(null); }
  };
  const resetAll = () => {
    if (!window.confirm("Wirklich ALLES löschen (Personen, Schichten, Buchungen)?")) return;
    const empty = { users: [], slots: {}, bookings: {} };
    setData(empty); dataRef.current = empty;
    store.reset();
    setMe(null); meStore.save(null);
  };

  /* ---- Buchungen ---- */
  const book = async (therapistId, sk, name, phone) => {
    const r = await store.book(therapistId, sk, name, phone);
    if (r.ok) {
      mutate((prev) => {
        const bookings = { ...(prev.bookings || {}) };
        bookings[therapistId] = { ...(bookings[therapistId] || {}), [sk]: { name, phone } };
        return { ...prev, bookings };
      });
      flash("Termin gebucht ✓");
      return true;
    }
    if (r.reason === "conflict") { flash("Dieser Slot wurde gerade gebucht."); refresh(); }
    else flash("Buchung fehlgeschlagen.");
    return false;
  };
  const removeBookingLocal = (therapistId, sk) => {
    mutate((prev) => {
      const bookings = { ...(prev.bookings || {}) };
      if (bookings[therapistId]) { const t = { ...bookings[therapistId] }; delete t[sk]; bookings[therapistId] = t; }
      return { ...prev, bookings };
    });
  };
  const cancelBooking = async (therapistId, sk) => {
    await store.cancelBooking(therapistId, sk);
    removeBookingLocal(therapistId, sk);
    flash("Buchung storniert.");
  };

  /* ---------------------------------------------------------------- */
  if (loading)
    return <div className="p-10 text-center text-slate-400 font-mono text-sm">lädt …</div>;

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-800 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-5">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">OASG Massage</h1>
            <button onClick={refresh} className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-500 hover:text-slate-900" title="Neu laden">
              <RefreshCw size={13} className={syncing ? "animate-spin" : ""} /> Aktualisieren
            </button>
          </div>
          <nav className="mt-3 inline-flex rounded-lg border border-slate-200 bg-white p-1 text-sm">
            <button onClick={() => go("book")} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition ${page === "book" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"}`}>
              <HandHeart size={14} /> Massage buchen
            </button>
            <button onClick={() => go("shifts")} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition ${page === "shifts" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"}`}>
              <CalendarDays size={14} /> Schichten eintragen
            </button>
          </nav>
        </header>

        {page === "book" ? (
          <BookingView data={data} onBook={book} onCancel={cancelBooking} />
        ) : (
          <ShiftView
            data={data} me={me} userHours={userHours}
            onCreate={createUser} onSelectMe={selectMe} onRemove={removeUser}
            onSaveSlots={saveUserSlots} onReset={resetAll} flash={flash} onEditingChange={handleEditingChange}
          />
        )}
      </div>

      {msg && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">{msg}</div>
      )}
    </div>
  );
}

/* ================================================================== *
 *  SEITE 1 — MASSAGE BUCHEN
 * ================================================================== */
function BookingView({ data, onBook, onCancel }) {
  const { users, slots, bookings } = data;
  const [tid, setTid] = useState(null);
  const [target, setTarget] = useState(null);     // {date, m} → Buchungs-Dialog
  const [cancelTarget, setCancelTarget] = useState(null); // {date, m, b} → Storno-Dialog
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (users.length && (!tid || !users.some((u) => u.id === tid))) setTid(users[0].id);
    if (!users.length) setTid(null);
  }, [users, tid]);

  const therapist = users.find((u) => u.id === tid);
  const onShift = (date, m) => (slots[slotKey(date, m)] || []).includes(tid);
  const bookingFor = (date, m) => therapist && bookings?.[tid]?.[slotKey(date, m)];

  const openBooking = (date, m) => { setTarget({ date, m }); setName(""); setPhone(""); };
  const confirmBooking = async () => {
    if (!name.trim() || !phoneValid(phone)) return;
    setBusy(true);
    const ok = await onBook(tid, slotKey(target.date, target.m), name.trim(), phone.trim());
    setBusy(false);
    if (ok) setTarget(null);
  };
  const confirmCancel = () => {
    onCancel(tid, slotKey(cancelTarget.date, cancelTarget.m));
    setCancelTarget(null);
  };

  if (!users.length)
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm text-slate-500">
          Noch keine Therapeuten eingetragen. Wechsle zu „Schichten eintragen", damit sich
          die Masseure mit ihren Schichten erfassen — dann kannst du hier buchen.
        </p>
      </div>
    );

  const okToBook = name.trim() && phoneValid(phone);

  return (
    <>
      <p className="mb-3 font-mono text-xs text-slate-500">
        Therapeut wählen → freien 30-min-Slot antippen → Name &amp; Handynummer eingeben.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {users.map((u) => {
          const active = u.id === tid;
          return (
            <button key={u.id} onClick={() => setTid(u.id)}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${active ? "border-slate-800 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300"}`}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: u.color }} />
              <span className="font-medium">{u.name}</span>
            </button>
          );
        })}
      </div>

      <section className="mb-4 rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <div style={{ display: "grid", gridTemplateColumns: GRID_COLS, gap: "4px" }}>
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
                <div className={`flex items-center justify-end pr-1 font-mono text-[11px] ${isHour ? "text-slate-500" : "text-slate-300"}`}>{fmt(m)}</div>
                {DAYS.map((d) => {
                  const shift = onShift(d.date, m);
                  const b = bookingFor(d.date, m);
                  if (!shift) return <div key={d.date + m} style={{ minHeight: 34 }} className="rounded-md bg-slate-50" />;
                  if (b)
                    return (
                      <button key={d.date + m} onClick={() => setCancelTarget({ date: d.date, m, b })}
                        title={`${b.name} – ${b.phone}`} style={{ minHeight: 34, backgroundColor: therapist.color }}
                        className="flex items-center justify-center rounded-md px-1 text-[10px] font-semibold text-white">
                        <span className="truncate">{b.name}</span>
                      </button>
                    );
                  return (
                    <button key={d.date + m} onClick={() => openBooking(d.date, m)} style={{ minHeight: 34 }}
                      className="flex items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 text-[10px] font-medium text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100">
                      frei
                    </button>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-emerald-300 bg-emerald-50" /> frei</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: therapist?.color }} /> gebucht</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-slate-100" /> keine Schicht</span>
        </div>
      </section>

      {/* Buchungs-Dialog */}
      {target && therapist && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4" onClick={() => !busy && setTarget(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4">
              <h3 className="text-base font-semibold text-slate-900">Termin buchen</h3>
              <p className="mt-1 font-mono text-xs text-slate-500">{therapist.name} · {dayLabel(target.date)} · {fmt(target.m)}–{fmt(target.m + SLOT_MINUTES)}</p>
            </div>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[11px] text-slate-400">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-800" placeholder="Vor- und Nachname" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[11px] text-slate-400">Handynummer</span>
                <input value={phone} onChange={(e) => setPhone(sanitizePhone(e.target.value))} type="tel" inputMode="tel"
                  onKeyDown={(e) => e.key === "Enter" && confirmBooking()}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono outline-none focus:border-slate-800" placeholder="+41 oder 079…" />
                {phone && !phoneValid(phone) && (
                  <span className="font-mono text-[11px] text-rose-500">Nur Ziffern, optional ein + am Anfang (mind. 7 Ziffern).</span>
                )}
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setTarget(null)} disabled={busy} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">Abbrechen</button>
              <button onClick={confirmBooking} disabled={busy || !okToBook}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40">
                <Phone size={14} /> {busy ? "buche …" : "Buchen"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Storno-Dialog */}
      {cancelTarget && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4" onClick={() => setCancelTarget(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle size={18} className="text-rose-500" />
              <h3 className="text-base font-semibold text-slate-900">Buchung stornieren?</h3>
            </div>
            <p className="text-sm text-slate-600">
              {therapist?.name} · {dayLabel(cancelTarget.date)} · {fmt(cancelTarget.m)}–{fmt(cancelTarget.m + SLOT_MINUTES)}
              <br /><b className="text-slate-800">{cancelTarget.b.name}</b> · {cancelTarget.b.phone}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setCancelTarget(null)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">Behalten</button>
              <button onClick={confirmCancel} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500">Stornieren</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ================================================================== *
 *  SEITE 2 — SCHICHTEN EINTRAGEN
 * ================================================================== */
function ShiftView({ data, me, userHours, onCreate, onSelectMe, onRemove, onSaveSlots, onReset, flash, onEditingChange }) {
  const [name, setName] = useState("");
  const [mDay, setMDay] = useState(DAYS[0].date);
  const [mVon, setMVon] = useState(DAY_START);
  const [mBis, setMBis] = useState(DAY_START + TARGET_HOURS * 60);
  const [editMode, setEditMode] = useState(false);
  const [draftKeys, setDraftKeys] = useState([]);
  const [shiftRemoveTarget, setShiftRemoveTarget] = useState(null);
  const [saving, setSaving] = useState(false);

  const painting = useRef(false);
  const paintAdd = useRef(true);
  const bookedHit = useRef(false);

  const meUser = data.users.find((u) => u.id === me);
  const allDone = data.users.length > 0 && data.users.every((u) => userHours(data, u.id) >= TARGET_HOURS);
  const submit = () => { onCreate(name); setName(""); };
  const liveKeys = me ? Object.keys(data.slots).filter((k) => data.slots[k].includes(me)).sort() : [];
  const draftSet = new Set(draftKeys);
  const bookedMine = useCallback((k) => !!(me && data.bookings?.[me]?.[k]), [data.bookings, me]);

  useEffect(() => {
    onEditingChange(editMode);
    return () => onEditingChange(false);
  }, [editMode, onEditingChange]);

  useEffect(() => {
    if (editMode) {
      setDraftKeys(liveKeys);
    } else {
      setDraftKeys(liveKeys);
      setShiftRemoveTarget(null);
      painting.current = false;
      bookedHit.current = false;
    }
  }, [editMode, liveKeys.join("|")]);

  useEffect(() => {
    const up = () => {
      painting.current = false;
      if (bookedHit.current) {
        bookedHit.current = false;
        flash("Gebuchte Slots wurden nicht entfernt – erst speichern, dann wird storniert.");
      }
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [flash]);

  const startEdit = () => {
    if (!me) return;
    setDraftKeys(liveKeys);
    setShiftRemoveTarget(null);
    setEditMode(true);
  };

  const cancelEdit = () => {
    setDraftKeys(liveKeys);
    setShiftRemoveTarget(null);
    painting.current = false;
    bookedHit.current = false;
    setEditMode(false);
  };

  const applyDraftSlot = useCallback((date, m) => {
    if (!me) return;
    const k = slotKey(date, m);
    const liveHas = !!data.slots[k]?.includes(me);
    const draftHas = draftSet.has(k);
    const liveCount = data.slots[k]?.length || 0;

    if (paintAdd.current) {
      if (draftHas) return;
      if (!liveHas && liveCount >= MAX_PER_SLOT) { flash(`Slot voll – max. ${MAX_PER_SLOT} gleichzeitig.`); return; }
      setDraftKeys((prev) => Array.from(new Set([...prev, k])).sort());
    } else {
      if (!draftHas) return;
      if (bookedMine(k)) { bookedHit.current = true; return; }
      setDraftKeys((prev) => prev.filter((key) => key !== k));
    }
  }, [bookedMine, data.slots, draftSet, flash, me]);

  const onCellDown = (e, date, m) => {
    if (!editMode) return;
    if (!me) { flash("Wähle oben zuerst, wer du bist."); return; }
    const k = slotKey(date, m);
    const draftHas = draftSet.has(k);
    if (draftHas && bookedMine(k)) {
      setShiftRemoveTarget({ date, m });
      return;
    }
    const isTouch = e.pointerType === "touch";
    if (!isTouch) e.preventDefault();
    paintAdd.current = !draftHas;
    painting.current = !isTouch;
    applyDraftSlot(date, m);
  };

  const onGridMove = (e) => {
    if (!editMode || !painting.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest("[data-cell]");
    if (cell) applyDraftSlot(cell.dataset.date, Number(cell.dataset.min));
  };

  const onManual = (mDayValue, mVonValue, mBisValue, add) => {
    if (!editMode) return flash("Zum Bearbeiten erst auf „Bearbeiten“ tippen.");
    if (!me) return flash("Wähle oben zuerst, wer du bist.");
    if (mVonValue >= mBisValue) return flash("„Von“ muss kleiner als „Bis“ sein.");
    let done = 0;
    let skip = 0;
    let bookedSkip = 0;
    setDraftKeys((prevDraft) => {
      const next = new Set(prevDraft);
      for (let m = mVonValue; m < mBisValue; m += SLOT_MINUTES) {
        const k = slotKey(mDayValue, m);
        const liveHas = !!data.slots[k]?.includes(me);
        const draftHas = next.has(k);
        const liveCount = data.slots[k]?.length || 0;
        if (add) {
          if (draftHas) continue;
          if (!liveHas && liveCount >= MAX_PER_SLOT) { skip++; continue; }
          next.add(k);
          done++;
        } else {
          if (!draftHas) continue;
          if (bookedMine(k)) { bookedSkip++; continue; }
          next.delete(k);
          done++;
        }
      }
      return Array.from(next).sort();
    });
    if (add)
      flash(`${fmtH(done * SLOT_HOURS)} h vorgemerkt${skip ? `, ${fmtH(skip * SLOT_HOURS)} h übersprungen (voll)` : ""}.`);
    else
      flash(`${fmtH(done * SLOT_HOURS)} h vorgemerkt zum Austragen${bookedSkip ? `, ${bookedSkip} gebuchte Slot(s) übersprungen` : ""}.`);
  };

  const saveEdit = async () => {
    if (!me || saving) return;
    setSaving(true);
    const removedBookedKeys = liveKeys.filter((k) => !draftSet.has(k) && bookedMine(k));
    await onSaveSlots(me, draftKeys, removedBookedKeys);
    setSaving(false);
    setShiftRemoveTarget(null);
    setEditMode(false);
    flash("Schichten gespeichert.");
  };

  const confirmShiftRemove = () => {
    if (!shiftRemoveTarget) return;
    const { date, m } = shiftRemoveTarget;
    const k = slotKey(date, m);
    setDraftKeys((prev) => prev.filter((key) => key !== k));
    bookedHit.current = true;
    setShiftRemoveTarget(null);
  };

  const displayedHourCount = (k) => {
    if (!editMode) return data.slots[k]?.length || 0;
    const liveHas = !!data.slots[k]?.includes(me);
    const draftHas = draftSet.has(k);
    return (data.slots[k]?.length || 0) + (draftHas && !liveHas ? 1 : 0) - (!draftHas && liveHas ? 1 : 0);
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Clock size={13} /> Soll {TARGET_HOURS} h / Person</span>
        <span className="inline-flex items-center gap-1"><Users size={13} /> max. {MAX_PER_SLOT} gleichzeitig</span>
        <span className="inline-flex items-center gap-1"><MousePointerClick size={13} /> Maus: ziehen · Handy: tippen</span>
        <span>25.–28.06.2026</span>
      </div>

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-slate-700">Wer bist du?</h2>
        </div>
        <div className="flex flex-col gap-2">
          {data.users.map((u) => {
            const h = userHours(data, u.id);
            const pct = Math.min(100, (h / TARGET_HOURS) * 100);
            const reached = h >= TARGET_HOURS;
            const active = u.id === me;
            return (
              <div key={u.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition ${active ? "border-slate-800 bg-slate-50" : "border-slate-200"}`}>
                <button onClick={() => !editMode && onSelectMe(u.id)} disabled={editMode} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60" title={editMode ? "Während des Bearbeitens gesperrt" : "Als aktive Person wählen"}>
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: u.color }}>{u.name.slice(0, 2).toUpperCase()}</span>
                  <span className="truncate text-sm font-medium">{u.name}</span>
                  {active && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-white">das bist du</span>}
                </button>
                <div className="hidden w-28 sm:block">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: reached ? "#10b981" : u.color }} />
                  </div>
                </div>
                <span className={`flex w-20 items-center justify-end gap-1 font-mono text-xs tabular-nums ${reached ? "text-emerald-600" : "text-slate-500"}`}>
                  {reached && <Check size={13} />}{fmtH(h)}/{TARGET_HOURS} h
                </span>
                <button onClick={() => onRemove(u.id)} className="text-slate-300 hover:text-rose-500" title="Person entfernen"><X size={15} /></button>
              </div>
            );
          })}
          {data.users.length < MAX_USERS && (
            <div className="flex gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="Name eingeben …" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-800" />
              <button onClick={submit} className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"><Plus size={15} /> Erstellen</button>
            </div>
          )}
        </div>
      </section>

      <section className="mb-4 rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2 font-mono text-xs text-slate-500">
            {meUser ? <span>aktiv: <b style={{ color: meUser.color }}>{meUser.name}</b></span> : <span>aktiv: niemand gewählt</span>}
            {!editMode && <span className="inline-flex items-center gap-1"><Lock size={11} /> Board gesperrt</span>}
          </div>
          <div className="flex items-center gap-2">
            {!editMode ? (
              <button onClick={startEdit} disabled={!me} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40">Bearbeiten</button>
            ) : (
              <>
                <button onClick={cancelEdit} disabled={saving} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Abbrechen</button>
                <button onClick={saveEdit} disabled={saving} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">{saving ? "Speichere …" : "Speichern"}</button>
              </>
            )}
          </div>
        </div>
        <div className="select-none" onPointerMove={onGridMove} style={{ display: "grid", gridTemplateColumns: GRID_COLS, gap: "4px" }}>
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
                <div className={`flex items-center justify-end pr-1 font-mono text-[11px] ${isHour ? "text-slate-500" : "text-slate-300"}`}>{fmt(m)}</div>
                {DAYS.map((d) => {
                  const k = slotKey(d.date, m);
                  const arr = data.slots[k] || [];
                  const liveHas = me && arr.includes(me);
                  const draftHas = draftSet.has(k);
                  const mine = editMode ? draftHas : liveHas;
                  const count = displayedHourCount(k);
                  const full = count >= MAX_PER_SLOT && !mine;
                  const booked = mine && bookedMine(k);
                  const visibleIds = editMode
                    ? [
                        ...arr.filter((id) => id !== me),
                        ...(draftHas ? [me] : []),
                      ].filter(Boolean)
                    : arr;
                  return (
                    <div key={d.date + m} data-cell data-date={d.date} data-min={m}
                      onPointerDown={editMode ? (e) => onCellDown(e, d.date, m) : undefined}
                      style={{ touchAction: "pan-y", minHeight: 34 }}
                      className={`relative flex ${editMode ? "cursor-pointer" : "cursor-default"} items-center justify-center gap-1 rounded-md border transition ${
                        mine ? "border-slate-800" : full ? "border-slate-200 bg-slate-100 cursor-not-allowed" : "border-slate-150 bg-white hover:border-slate-300"
                      } ${isHour ? "" : "border-dashed"}`}
                      title={booked ? "In diesem Slot liegt eine Buchung" : undefined}
                    >
                      {visibleIds.length === 0 ? (
                        <Plus size={12} className="text-slate-200" />
                      ) : (
                        visibleIds.map((id) => {
                          const u = data.users.find((x) => x.id === id);
                          if (!u) return null;
                          return <span key={id} className="grid h-5 w-5 place-items-center rounded-full text-[9px] font-bold text-white" style={{ backgroundColor: u.color }} title={u.name}>{u.name.slice(0, 2).toUpperCase()}</span>;
                        })
                      )}
                      {full && <Lock size={9} className="text-slate-300" />}
                      {booked && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" title="gebucht" />}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
        <div className="mt-3 font-mono text-[11px] text-slate-400">
          {!editMode ? (
            <span className="inline-flex items-center gap-1"><Lock size={11} /> Board gesperrt – erst auf „Bearbeiten“ tippen</span>
          ) : (
            <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Änderungen sind nur vorgemerkt, bis du speicherst.</span>
          )}
        </div>
      </section>

      <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Manuell eintragen</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-slate-400">Tag</span>
            <select value={mDay} onChange={(e) => setMDay(e.target.value)} disabled={!editMode} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
              {DAYS.map((d) => <option key={d.date} value={d.date}>{d.wd} {d.dm}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-slate-400">Von</span>
            <select value={mVon} onChange={(e) => setMVon(Number(e.target.value))} disabled={!editMode} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono outline-none focus:border-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
              {SLOTS.map((m) => <option key={m} value={m}>{fmt(m)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-slate-400">Bis</span>
            <select value={mBis} onChange={(e) => setMBis(Number(e.target.value))} disabled={!editMode} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono outline-none focus:border-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
              {SLOTS.map((m) => m + SLOT_MINUTES).map((m) => <option key={m} value={m}>{fmt(m)}</option>)}
            </select>
          </label>
          <button onClick={() => onManual(mDay, mVon, mBis, true)} disabled={!editMode} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40">Eintragen</button>
          <button onClick={() => onManual(mDay, mVon, mBis, false)} disabled={!editMode} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Austragen</button>
        </div>
      </section>

      <div className="flex items-center justify-between">
        {allDone ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-emerald-600"><Check size={14} /> Alle haben ihr Soll erreicht</span>
        ) : (
          <span className="font-mono text-xs text-slate-400">Geteilter Plan · „Aktualisieren" zeigt die neuesten Einträge.</span>
        )}
        <button onClick={onReset} className="inline-flex items-center gap-1 font-mono text-xs text-slate-400 hover:text-rose-500"><Trash2 size={13} /> Zurücksetzen</button>
      </div>

      {shiftRemoveTarget && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 px-4" onClick={() => setShiftRemoveTarget(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500" />
              <h3 className="text-base font-semibold text-slate-900">Slot ist gebucht</h3>
            </div>
            <p className="text-sm text-slate-600">
              {dayLabel(shiftRemoveTarget.date)} · {fmt(shiftRemoveTarget.m)}–{fmt(shiftRemoveTarget.m + SLOT_MINUTES)} hat eine Buchung.
              Wenn du diese Schicht entfernst, wird die Buchung beim Speichern storniert.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShiftRemoveTarget(null)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">Behalten</button>
              <button onClick={confirmShiftRemove} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500">Entfernen</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}