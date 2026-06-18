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
  const [shiftRemoveTarget, setShiftRemoveTarget] = useState(null); // {date, m}

  const dataRef = useRef(data);
  const meRef = useRef(me);
  const painting = useRef(false);
  const paintAdd = useRef(true);
  const bookedHit = useRef(false);
  const lastPointer = useRef("mouse");
  const slotTimer = useRef(null);
  const pendingSlots = useRef(null);
  const msgTimer = useRef(null);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { meRef.current = me; }, [me]);

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

  const refresh = useCallback(async () => {
    setSyncing(true);
    await flushSlots();
    const d = await store.load();
    if (d) {
      setData(d); dataRef.current = d;
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

  useEffect(() => {
    const onFocus = () => { if (!painting.current) refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    const up = () => {
      painting.current = false;
      if (bookedHit.current) {
        bookedHit.current = false;
        flash("Gebuchte Slots wurden nicht entfernt – zum Stornieren einzeln anklicken.");
      }
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [flash]);

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

  /* ---- Schicht-Slots setzen ---- */
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
          if (isBooked(prev, id, k)) { bookedHit.current = true; return prev; } // Buchung beim Ziehen schützen
          arr.splice(arr.indexOf(id), 1);
        }
        const slots = { ...prev.slots };
        if (arr.length) slots[k] = arr; else delete slots[k];
        return { ...prev, slots };
      },
      (next) => scheduleSaveSlots(id, next)
    );
  }, [mutate, flash, scheduleSaveSlots]);

  const onCellDown = (e, date, m) => {
    if (!meRef.current) { flash("Wähle oben zuerst, wer du bist."); return; }
    const k = slotKey(date, m);
    const arr = dataRef.current.slots[k] || [];
    const has = arr.includes(meRef.current);
    if (has && isBooked(dataRef.current, meRef.current, k)) { // gebuchten Slot entfernen → Warn-Popup
      setShiftRemoveTarget({ date, m });
      return;
    }
    const isTouch = e.pointerType === "touch";
    if (!isTouch) e.preventDefault();
    paintAdd.current = !has;
    painting.current = !isTouch;
    applyPaint(date, m);
  };
  const onGridMove = (e) => {
    if (!painting.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest("[data-cell]");
    if (cell) applyPaint(cell.dataset.date, Number(cell.dataset.min));
  };

  const manual = (mDay, mVon, mBis, add) => {
    if (!me) return flash("Wähle oben zuerst, wer du bist.");
    if (mVon >= mBis) return flash("„Von“ muss kleiner als „Bis“ sein.");
    let done = 0, skip = 0, bookedSkip = 0;
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
            if (isBooked(prev, me, k)) { bookedSkip++; continue; } // gebuchte Slots nicht austragen
            arr.splice(arr.indexOf(me), 1); done++;
          }
          if (arr.length) slots[k] = arr; else delete slots[k];
        }
        return { ...prev, slots };
      },
      (next) => scheduleSaveSlots(me, next)
    );
    if (add)
      flash(`${fmtH(done * SLOT_HOURS)} h eingetragen${skip ? `, ${fmtH(skip * SLOT_HOURS)} h übersprungen (voll)` : ""}.`);
    else
      flash(`${fmtH(done * SLOT_HOURS)} h ausgetragen${bookedSkip ? `, ${bookedSkip} gebuchte Slot(s) übersprungen` : ""}.`);
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

  /* ---- Schicht-Slot mit Buchung entfernen (bestätigt) ---- */
  const confirmShiftRemove = async () => {
    const { date, m } = shiftRemoveTarget;
    const k = slotKey(date, m);
    await store.cancelBooking(me, k);
    mutate(
      (prev) => {
        const arr = (prev.slots[k] || []).filter((x) => x !== me);
        const slots = { ...prev.slots };
        if (arr.length) slots[k] = arr; else delete slots[k];
        const bookings = { ...(prev.bookings || {}) };
        if (bookings[me]) { const t = { ...bookings[me] }; delete t[k]; bookings[me] = t; }
        return { ...prev, slots, bookings };
      },
      (next) => scheduleSaveSlots(me, next)
    );
    setShiftRemoveTarget(null);
    flash("Schicht entfernt & Buchung storniert.");
  };

  /* ---------------------------------------------------------------- */
  if (loading)
    return <div className="p-10 text-center text-slate-400 font-mono text-sm">lädt …</div>;

  const removeBooking = shiftRemoveTarget ? data.bookings?.[me]?.[slotKey(shiftRemoveTarget.date, shiftRemoveTarget.m)] : null;

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
            onCellDown={onCellDown} onGridMove={onGridMove} onManual={manual} onReset={resetAll}
          />
        )}
      </div>

      {/* Warn-Popup: Schicht-Slot mit Buchung entfernen */}
      {shiftRemoveTarget && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 px-4" onClick={() => setShiftRemoveTarget(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500" />
              <h3 className="text-base font-semibold text-slate-900">Slot ist gebucht</h3>
            </div>
            <p className="text-sm text-slate-600">
              {dayLabel(shiftRemoveTarget.date)} · {fmt(shiftRemoveTarget.m)}–{fmt(shiftRemoveTarget.m + SLOT_MINUTES)} hat eine Buchung
              {removeBooking ? <> von <b className="text-slate-800">{removeBooking.name}</b> ({removeBooking.phone})</> : null}.
              Wenn du deine Schicht hier entfernst, wird diese Buchung <b>storniert</b>.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShiftRemoveTarget(null)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">Behalten</button>
              <button onClick={confirmShiftRemove} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500">Entfernen &amp; stornieren</button>
            </div>
          </div>
        </div>
      )}

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
function ShiftView({ data, me, userHours, onCreate, onSelectMe, onRemove, onCellDown, onGridMove, onManual, onReset }) {
  const [name, setName] = useState("");
  const [mDay, setMDay] = useState(DAYS[0].date);
  const [mVon, setMVon] = useState(DAY_START);
  const [mBis, setMBis] = useState(DAY_START + TARGET_HOURS * 60);

  const meUser = data.users.find((u) => u.id === me);
  const allDone = data.users.length > 0 && data.users.every((u) => userHours(data, u.id) >= TARGET_HOURS);
  const submit = () => { onCreate(name); setName(""); };
  const bookedMine = (k) => !!(me && data.bookings?.[me]?.[k]);

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Clock size={13} /> Soll {TARGET_HOURS} h / Person</span>
        <span className="inline-flex items-center gap-1"><Users size={13} /> max. {MAX_PER_SLOT} gleichzeitig</span>
        <span className="inline-flex items-center gap-1"><MousePointerClick size={13} /> Maus: ziehen · Handy: tippen</span>
        <span>25.–28.06.2026</span>
      </div>

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Wer bist du?</h2>
          {meUser && <span className="font-mono text-xs text-slate-500">aktiv: <b style={{ color: meUser.color }}>{meUser.name}</b></span>}
        </div>
        <div className="flex flex-col gap-2">
          {data.users.map((u) => {
            const h = userHours(data, u.id);
            const pct = Math.min(100, (h / TARGET_HOURS) * 100);
            const reached = h >= TARGET_HOURS;
            const active = u.id === me;
            return (
              <div key={u.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition ${active ? "border-slate-800 bg-slate-50" : "border-slate-200"}`}>
                <button onClick={() => onSelectMe(u.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title="Als aktive Person wählen">
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
                  const mine = me && arr.includes(me);
                  const full = arr.length >= MAX_PER_SLOT && !mine;
                  const booked = mine && bookedMine(k);
                  return (
                    <div key={d.date + m} data-cell data-date={d.date} data-min={m}
                      onPointerDown={(e) => onCellDown(e, d.date, m)}
                      style={{ touchAction: "pan-y", minHeight: 34 }}
                      className={`relative flex cursor-pointer items-center justify-center gap-1 rounded-md border transition ${
                        mine ? "border-slate-800" : full ? "border-slate-200 bg-slate-100 cursor-not-allowed" : "border-slate-150 bg-white hover:border-slate-300"
                      } ${isHour ? "" : "border-dashed"}`}
                      title={booked ? "In diesem Slot liegt eine Buchung" : undefined}
                    >
                      {arr.length === 0 ? (
                        <Plus size={12} className="text-slate-200" />
                      ) : (
                        arr.map((id) => {
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
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Slot mit Buchung – Entfernen warnt und storniert</span>
        </div>
      </section>

      <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Manuell eintragen</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-slate-400">Tag</span>
            <select value={mDay} onChange={(e) => setMDay(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-slate-800">
              {DAYS.map((d) => <option key={d.date} value={d.date}>{d.wd} {d.dm}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-slate-400">Von</span>
            <select value={mVon} onChange={(e) => setMVon(Number(e.target.value))} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono outline-none focus:border-slate-800">
              {SLOTS.map((m) => <option key={m} value={m}>{fmt(m)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-slate-400">Bis</span>
            <select value={mBis} onChange={(e) => setMBis(Number(e.target.value))} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono outline-none focus:border-slate-800">
              {SLOTS.map((m) => m + SLOT_MINUTES).map((m) => <option key={m} value={m}>{fmt(m)}</option>)}
            </select>
          </label>
          <button onClick={() => onManual(mDay, mVon, mBis, true)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">Eintragen</button>
          <button onClick={() => onManual(mDay, mVon, mBis, false)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">Austragen</button>
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
    </>
  );
}