import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Plus, X, ChevronLeft, ChevronRight, Trash2, Settings2, AlertTriangle, Users, MapPin } from "lucide-react";
import { supabase, supabaseConfigured } from "./supabaseClient";

// ---------- constants ----------

const DAY_START = 8;   // 08:00
const DAY_END = 22;    // 22:00
const SLOT_MIN = 30;   // grid resolution in minutes
const PITCH_COLORS = ["#2D6A4F", "#B5651D", "#3D5A80", "#8E5572", "#5F7A34", "#7B4B2A"];

const DEFAULT_PITCHES = [
  { id: "p1", name: "Main Pitch" },
  { id: "p2", name: "Training Pitch" },
];

// ---------- date helpers ----------

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeek(d) {
  const date = new Date(d);
  const dow = (date.getDay() + 6) % 7; // Monday = 0
  date.setDate(date.getDate() - dow);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d, n) {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToLabel(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

function fmtDayLabel(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---------- overlap check ----------

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export default function PitchBooker() {
  const [pitches, setPitches] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => toISODate(new Date()));

  const [modalOpen, setModalOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [detailBooking, setDetailBooking] = useState(null);
  const [now, setNow] = useState(new Date());

  // ---- helpers to map between DB rows and the shape the UI uses ----
  function rowToBooking(row) {
    return {
      id: row.id,
      pitchId: row.pitch_id,
      date: row.date,
      start: row.start_time,
      end: row.end_time,
      coach: row.coach,
      team: row.team,
      notes: row.notes || "",
      createdAt: row.created_at,
    };
  }

  const fetchPitches = useCallback(async () => {
    const { data, error: err } = await supabase.from("pitches").select("*").order("sort_order", { ascending: true });
    if (err) throw err;
    return (data || []).map((r) => ({ id: r.id, name: r.name }));
  }, []);

  const fetchBookings = useCallback(async () => {
    const { data, error: err } = await supabase.from("bookings").select("*").order("date", { ascending: true });
    if (err) throw err;
    return (data || []).map(rowToBooking);
  }, []);

  // ---- load ----
  useEffect(() => {
    if (!supabaseConfigured) {
      setPitches(DEFAULT_PITCHES);
      setBookings([]);
      setError("Not connected to the database yet — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
      setLoading(false);
      return;
    }

    (async () => {
      try {
        let p = await fetchPitches();
        if (!p.length) {
          await supabase.from("pitches").insert(
            DEFAULT_PITCHES.map((pitch, i) => ({ id: pitch.id, name: pitch.name, sort_order: i }))
          );
          p = await fetchPitches();
        }
        setPitches(p);

        const b = await fetchBookings();
        setBookings(b);
      } catch (e) {
        console.error(e);
        setError("Couldn't load the pitch book. Check your connection and try reloading.");
        setPitches(DEFAULT_PITCHES);
        setBookings([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchPitches, fetchBookings]);

  // ---- realtime: keep every coach's screen in sync automatically ----
  useEffect(() => {
    if (!supabaseConfigured) return;
    const channel = supabase
      .channel("pitch-book-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, async () => {
        try {
          setBookings(await fetchBookings());
        } catch {
          // ignore transient refresh errors; next change event will retry
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "pitches" }, async () => {
        try {
          setPitches(await fetchPitches());
        } catch {
          // ignore
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchBookings, fetchPitches]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  // Diff the edited pitch list against what's stored and push only the changes.
  const savePitches = useCallback(
    async (next) => {
      const previous = pitches || [];
      setPitches(next);
      if (!supabaseConfigured) return;
      try {
        const prevIds = new Set(previous.map((p) => p.id));
        const nextIds = new Set(next.map((p) => p.id));
        const removed = previous.filter((p) => !nextIds.has(p.id));
        const upserts = next.map((p, i) => ({ id: p.id, name: p.name, sort_order: i }));

        if (upserts.length) {
          const { error: err } = await supabase.from("pitches").upsert(upserts);
          if (err) throw err;
        }
        for (const p of removed) {
          const { error: err } = await supabase.from("pitches").delete().eq("id", p.id);
          if (err) throw err;
        }
      } catch (e) {
        console.error(e);
        setError("Couldn't save pitch changes.");
      }
    },
    [pitches]
  );

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const dayBookings = useMemo(() => {
    if (!bookings) return [];
    return bookings.filter((b) => b.date === selectedDate).sort((a, b) => a.start.localeCompare(b.start));
  }, [bookings, selectedDate]);

  const isToday = selectedDate === toISODate(new Date());

  function findConflict(list, pitchId, date, start, end, excludeId) {
    return (list || []).find(
      (b) =>
        b.id !== excludeId &&
        b.pitchId === pitchId &&
        b.date === date &&
        overlaps(timeToMinutes(start), timeToMinutes(end), timeToMinutes(b.start), timeToMinutes(b.end))
    );
  }

  async function handleSaveBooking(form, editingId) {
    if (!supabaseConfigured) {
      return { error: null, offline: true };
    }
    try {
      // Re-check against the live table right before writing, so two coaches
      // tapping "confirm" seconds apart can't both grab the same slot.
      const { data, error: fetchErr } = await supabase
        .from("bookings")
        .select("*")
        .eq("pitch_id", form.pitchId)
        .eq("date", form.date);
      if (fetchErr) throw fetchErr;

      const liveConflict = findConflict(data.map(rowToBooking), form.pitchId, form.date, form.start, form.end, editingId);
      if (liveConflict) {
        return { error: liveConflict };
      }

      const row = {
        pitch_id: form.pitchId,
        date: form.date,
        start_time: form.start,
        end_time: form.end,
        coach: form.coach,
        team: form.team,
        notes: form.notes || "",
      };

      if (editingId) {
        const { error: err } = await supabase.from("bookings").update(row).eq("id", editingId);
        if (err) throw err;
      } else {
        const { error: err } = await supabase.from("bookings").insert({ id: genId(), ...row });
        if (err) throw err;
      }

      setBookings(await fetchBookings());
      return { error: null };
    } catch (e) {
      console.error(e);
      setError("Couldn't save the booking. Check your connection and try again.");
      return { error: null };
    }
  }

  async function handleDelete(id) {
    if (!supabaseConfigured) {
      setDetailBooking(null);
      return;
    }
    try {
      const { error: err } = await supabase.from("bookings").delete().eq("id", id);
      if (err) throw err;
      setBookings(await fetchBookings());
    } catch (e) {
      console.error(e);
      setError("Couldn't cancel the booking. Try again.");
    } finally {
      setDetailBooking(null);
    }
  }

  if (loading) {
    return (
      <div style={styles.page}>
        <style>{css}</style>
        <div className="pb-loading">Loading the pitch book…</div>
      </div>
    );
  }

  if (!pitches || !bookings) {
    return (
      <div style={styles.page}>
        <style>{css}</style>
        <div className="pb-loading">
          Something went wrong loading the pitch book. Try closing and reopening it.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page} className="pb-root">
      <style>{css}</style>

      <header className="pb-header">
        <div className="pb-header-inner">
          <div className="pb-crest" aria-hidden="true">
            <svg viewBox="0 0 40 40" width="34" height="34">
              <circle cx="20" cy="20" r="19" fill="none" stroke="#F8F9F4" strokeWidth="1.4" opacity="0.55" />
              <line x1="20" y1="1" x2="20" y2="39" stroke="#F8F9F4" strokeWidth="1" opacity="0.4" />
              <circle cx="20" cy="20" r="6" fill="none" stroke="#F8F9F4" strokeWidth="1" opacity="0.55" />
            </svg>
          </div>
          <div>
            <h1>Pitch Book</h1>
            <p className="pb-sub">See who's on, before you turn up.</p>
          </div>
          <button className="pb-icon-btn" onClick={() => setManageOpen(true)} aria-label="Manage pitches">
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      {error && (
        <div className="pb-error-banner">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="pb-week-nav">
        <button className="pb-icon-btn" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">
          <ChevronLeft size={18} />
        </button>
        <div className="pb-day-tabs">
          {weekDays.map((d) => {
            const iso = toISODate(d);
            const active = iso === selectedDate;
            const today = iso === toISODate(new Date());
            return (
              <button
                key={iso}
                className={`pb-day-tab ${active ? "active" : ""} ${today ? "today" : ""}`}
                onClick={() => setSelectedDate(iso)}
              >
                <span className="pb-day-name">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
                <span className="pb-day-num">{d.getDate()}</span>
              </button>
            );
          })}
        </div>
        <button className="pb-icon-btn" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="pb-date-heading">
        {new Date(selectedDate + "T00:00:00").toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
        })}
      </div>

      {pitches.length === 0 ? (
        <div className="pb-empty">
          <MapPin size={28} />
          <p>No pitches set up yet.</p>
          <button className="pb-btn-primary" onClick={() => setManageOpen(true)}>
            Add a pitch
          </button>
        </div>
      ) : (
        <ScheduleGrid
          pitches={pitches}
          dayBookings={dayBookings}
          isToday={isToday}
          now={now}
          onSelectBooking={setDetailBooking}
        />
      )}

      <button className="pb-fab" onClick={() => setModalOpen(true)}>
        <Plus size={20} />
        <span>Book pitch</span>
      </button>

      {modalOpen && (
        <BookingModal
          pitches={pitches}
          defaultDate={selectedDate}
          onClose={() => setModalOpen(false)}
          onSave={handleSaveBooking}
        />
      )}

      {detailBooking && (
        <DetailModal
          booking={detailBooking}
          pitch={pitches.find((p) => p.id === detailBooking.pitchId)}
          onClose={() => setDetailBooking(null)}
          onDelete={() => handleDelete(detailBooking.id)}
        />
      )}

      {manageOpen && (
        <ManagePitchesModal pitches={pitches} onClose={() => setManageOpen(false)} onSave={savePitches} />
      )}
    </div>
  );
}

// ---------- Schedule grid ----------

function ScheduleGrid({ pitches, dayBookings, isToday, now, onSelectBooking }) {
  const totalMinutes = (DAY_END - DAY_START) * 60;
  const hourMarks = [];
  for (let h = DAY_START; h <= DAY_END; h++) hourMarks.push(h * 60);

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const showNowLine = isToday && nowMinutes >= DAY_START * 60 && nowMinutes <= DAY_END * 60;

  const pxPerMin = 1.6; // vertical scale
  const gridHeight = totalMinutes * pxPerMin;

  return (
    <div className="pb-grid-wrap">
      <div className="pb-grid" style={{ height: gridHeight + 8 }}>
        <div className="pb-time-col">
          {hourMarks.map((m) => (
            <div key={m} className="pb-time-mark" style={{ top: (m - DAY_START * 60) * pxPerMin }}>
              {minutesToLabel(m)}
            </div>
          ))}
        </div>

        <div className="pb-pitch-cols">
          {pitches.map((pitch, idx) => {
            const color = PITCH_COLORS[idx % PITCH_COLORS.length];
            const items = dayBookings.filter((b) => b.pitchId === pitch.id);
            return (
              <div key={pitch.id} className="pb-pitch-col">
                <div className="pb-pitch-col-header" style={{ borderTopColor: color }}>
                  {pitch.name}
                </div>
                <div className="pb-pitch-col-body" style={{ height: gridHeight }}>
                  {hourMarks.map((m) => (
                    <div key={m} className="pb-hline" style={{ top: (m - DAY_START * 60) * pxPerMin }} />
                  ))}
                  {items.map((b) => {
                    const top = (timeToMinutes(b.start) - DAY_START * 60) * pxPerMin;
                    const height = Math.max((timeToMinutes(b.end) - timeToMinutes(b.start)) * pxPerMin, 26);
                    return (
                      <button
                        key={b.id}
                        className="pb-booking-block"
                        style={{ top, height, background: color }}
                        onClick={() => onSelectBooking(b)}
                      >
                        <span className="pb-block-time">
                          {minutesToLabel(timeToMinutes(b.start))}–{minutesToLabel(timeToMinutes(b.end))}
                        </span>
                        <span className="pb-block-team">{b.team}</span>
                        <span className="pb-block-coach">{b.coach}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {showNowLine && (
        <div
          className="pb-now-line"
          style={{ top: 40 + (nowMinutes - DAY_START * 60) * pxPerMin }}
        >
          <span className="pb-now-dot" />
        </div>
      )}
    </div>
  );
}

// ---------- Booking modal ----------

function BookingModal({ pitches, defaultDate, onClose, onSave }) {
  const [pitchId, setPitchId] = useState(pitches[0]?.id || "");
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState("19:00");
  const [coach, setCoach] = useState("");
  const [team, setTeam] = useState("");
  const [notes, setNotes] = useState("");
  const [conflict, setConflict] = useState(null);
  const [saving, setSaving] = useState(false);

  const invalidTime = timeToMinutes(end) <= timeToMinutes(start);

  async function submit(e) {
    e.preventDefault();
    if (!coach.trim() || !team.trim() || invalidTime) return;
    setSaving(true);
    setConflict(null);
    const result = await onSave(
      { pitchId, date, start, end, coach: coach.trim(), team: team.trim(), notes: notes.trim() },
      null
    );
    setSaving(false);
    if (result.error) {
      setConflict(result.error);
    } else {
      onClose();
    }
  }

  return (
    <div className="pb-overlay" onClick={onClose}>
      <div className="pb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pb-modal-head">
          <h2>Book a pitch</h2>
          <button className="pb-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} className="pb-form">
          <label>
            Pitch
            <select value={pitchId} onChange={(e) => setPitchId(e.target.value)}>
              {pitches.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <div className="pb-form-row">
            <label>
              Start
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
            </label>
            <label>
              End
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </label>
          </div>
          {invalidTime && <div className="pb-inline-warning">End time must be after start time.</div>}
          <label>
            Team / session
            <input
              type="text"
              placeholder="e.g. U13 Boys training"
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              required
            />
          </label>
          <label>
            Coach
            <input
              type="text"
              placeholder="Your name"
              value={coach}
              onChange={(e) => setCoach(e.target.value)}
              required
            />
          </label>
          <label>
            Notes <span className="pb-optional">(optional)</span>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>

          {conflict && (
            <div className="pb-conflict-box">
              <AlertTriangle size={16} />
              <div>
                <strong>That pitch is already booked then.</strong>
                <div>
                  {conflict.team} with {conflict.coach}, {minutesToLabel(timeToMinutes(conflict.start))}–
                  {minutesToLabel(timeToMinutes(conflict.end))}
                </div>
              </div>
            </div>
          )}

          <button type="submit" className="pb-btn-primary pb-submit" disabled={saving}>
            {saving ? "Saving…" : "Confirm booking"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------- Detail modal ----------

function DetailModal({ booking, pitch, onClose, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="pb-overlay" onClick={onClose}>
      <div className="pb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pb-modal-head">
          <h2>{pitch?.name || "Pitch"}</h2>
          <button className="pb-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="pb-detail">
          <div className="pb-detail-row">
            <span className="pb-detail-label">When</span>
            <span>
              {new Date(booking.date + "T00:00:00").toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
              , {minutesToLabel(timeToMinutes(booking.start))}–{minutesToLabel(timeToMinutes(booking.end))}
            </span>
          </div>
          <div className="pb-detail-row">
            <span className="pb-detail-label">Team / session</span>
            <span>{booking.team}</span>
          </div>
          <div className="pb-detail-row">
            <span className="pb-detail-label">Coach</span>
            <span className="pb-coach-chip">
              <Users size={14} /> {booking.coach}
            </span>
          </div>
          {booking.notes && (
            <div className="pb-detail-row">
              <span className="pb-detail-label">Notes</span>
              <span>{booking.notes}</span>
            </div>
          )}
        </div>
        {!confirming ? (
          <button className="pb-btn-danger" onClick={() => setConfirming(true)}>
            <Trash2 size={16} /> Cancel booking
          </button>
        ) : (
          <div className="pb-confirm-row">
            <span>Cancel this booking?</span>
            <button className="pb-btn-danger" onClick={onDelete}>
              Yes, cancel
            </button>
            <button className="pb-btn-ghost" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Manage pitches modal ----------

function ManagePitchesModal({ pitches, onClose, onSave }) {
  const [list, setList] = useState(pitches);
  const [newName, setNewName] = useState("");

  function addPitch() {
    const name = newName.trim();
    if (!name) return;
    setList([...list, { id: genId(), name }]);
    setNewName("");
  }

  function removePitch(id) {
    setList(list.filter((p) => p.id !== id));
  }

  function renamePitch(id, name) {
    setList(list.map((p) => (p.id === id ? { ...p, name } : p)));
  }

  async function save() {
    await onSave(list);
    onClose();
  }

  return (
    <div className="pb-overlay" onClick={onClose}>
      <div className="pb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pb-modal-head">
          <h2>Manage pitches</h2>
          <button className="pb-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p className="pb-manage-note">Changes here are visible to every coach using this booker.</p>
        <div className="pb-pitch-list">
          {list.map((p) => (
            <div key={p.id} className="pb-pitch-row">
              <input value={p.name} onChange={(e) => renamePitch(p.id, e.target.value)} />
              <button className="pb-icon-btn" onClick={() => removePitch(p.id)} aria-label="Remove pitch">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <div className="pb-add-pitch-row">
          <input
            placeholder="New pitch name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addPitch())}
          />
          <button className="pb-btn-ghost" onClick={addPitch}>
            <Plus size={16} /> Add
          </button>
        </div>
        <button className="pb-btn-primary pb-submit" onClick={save}>
          Save pitches
        </button>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh" },
};

const css = `
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap');

.pb-root {
  --pitch-dark: #10261C;
  --pitch-mid: #1B4332;
  --pitch-line: #C9CDC5;
  --chalk: #F7F8F3;
  --charcoal: #16211C;
  --clay: #C1502E;
  --amber: #E9B44C;
  --card-bg: #FFFFFF;
  font-family: 'Inter', system-ui, sans-serif;
  background: var(--chalk);
  color: var(--charcoal);
  min-height: 100vh;
  padding-bottom: 90px;
}

.pb-loading {
  padding: 40px;
  text-align: center;
  font-family: 'Inter', sans-serif;
  color: #4B5D53;
}

.pb-header {
  background: linear-gradient(160deg, var(--pitch-dark), var(--pitch-mid) 65%);
  padding: 22px 18px 20px;
  color: var(--chalk);
  position: relative;
  overflow: hidden;
}
.pb-header::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    90deg,
    rgba(255,255,255,0.035) 0px,
    rgba(255,255,255,0.035) 34px,
    transparent 34px,
    transparent 68px
  );
  pointer-events: none;
}
.pb-header-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  position: relative;
  z-index: 1;
}
.pb-header-inner > div:nth-child(2) { flex: 1; }
.pb-header h1 {
  font-family: 'Oswald', sans-serif;
  font-weight: 600;
  font-size: 26px;
  letter-spacing: 0.5px;
  margin: 0;
  text-transform: uppercase;
}
.pb-sub {
  margin: 2px 0 0;
  font-size: 13px;
  opacity: 0.75;
}
.pb-crest { flex-shrink: 0; }

.pb-icon-btn {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.18);
  color: inherit;
  border-radius: 9px;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s ease;
}
.pb-icon-btn:hover { background: rgba(255,255,255,0.16); }
.pb-root > .pb-week-nav .pb-icon-btn,
.pb-modal .pb-icon-btn {
  background: rgba(16,38,28,0.06);
  border: 1px solid rgba(16,38,28,0.12);
  color: var(--charcoal);
}
.pb-root > .pb-week-nav .pb-icon-btn:hover,
.pb-modal .pb-icon-btn:hover { background: rgba(16,38,28,0.12); }

.pb-error-banner {
  background: #FDEDE7;
  color: #8C3A1E;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  font-size: 13px;
}
.pb-error-banner button { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; display:flex; }

.pb-week-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 14px 12px 4px;
}
.pb-day-tabs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  flex: 1;
  scrollbar-width: none;
}
.pb-day-tabs::-webkit-scrollbar { display: none; }
.pb-day-tab {
  border: 1px solid var(--pitch-line);
  background: var(--card-bg);
  border-radius: 10px;
  padding: 7px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 46px;
  cursor: pointer;
  font-family: 'Inter', sans-serif;
  color: var(--charcoal);
}
.pb-day-tab .pb-day-name {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.6;
}
.pb-day-tab .pb-day-num {
  font-family: 'Oswald', sans-serif;
  font-size: 17px;
  font-weight: 600;
}
.pb-day-tab.today { border-color: var(--amber); }
.pb-day-tab.active {
  background: var(--pitch-mid);
  border-color: var(--pitch-mid);
  color: var(--chalk);
}
.pb-day-tab.active .pb-day-name { opacity: 0.8; }

.pb-date-heading {
  font-family: 'Oswald', sans-serif;
  font-size: 16px;
  font-weight: 500;
  padding: 10px 16px 4px;
  color: var(--pitch-mid);
}

.pb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 60px 20px;
  color: #6B7C71;
  text-align: center;
}

.pb-grid-wrap {
  position: relative;
  padding: 8px 12px 24px;
}

.pb-grid {
  display: flex;
  position: relative;
}

.pb-time-col {
  position: relative;
  width: 48px;
  flex-shrink: 0;
  padding-top: 40px;
}
.pb-time-mark {
  position: absolute;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #7C8B81;
  transform: translateY(-50%);
  right: 8px;
  white-space: nowrap;
}

.pb-pitch-cols {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  flex: 1;
  padding-bottom: 4px;
}

.pb-pitch-col {
  min-width: 150px;
  flex: 1 0 150px;
  display: flex;
  flex-direction: column;
}
.pb-pitch-col-header {
  font-family: 'Oswald', sans-serif;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 6px 4px 8px;
  border-top: 3px solid;
  color: var(--charcoal);
  text-align: center;
}
.pb-pitch-col-body {
  position: relative;
  background: var(--card-bg);
  border: 1px solid var(--pitch-line);
  border-radius: 8px;
  margin-top: 6px;
}
.pb-hline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed #E3E7DF;
}
.pb-booking-block {
  position: absolute;
  left: 4px;
  right: 4px;
  border-radius: 7px;
  color: #fff;
  border: none;
  text-align: left;
  padding: 5px 7px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  cursor: pointer;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.18);
}
.pb-block-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  opacity: 0.85;
}
.pb-block-team {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
}
.pb-block-coach {
  font-size: 10.5px;
  opacity: 0.85;
}

.pb-now-line {
  position: absolute;
  left: 56px;
  right: 12px;
  border-top: 2px solid var(--clay);
}
.pb-now-dot {
  position: absolute;
  left: -5px;
  top: -5px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--clay);
}

.pb-fab {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: var(--pitch-mid);
  color: var(--chalk);
  border: none;
  border-radius: 999px;
  padding: 13px 18px;
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: 'Inter', sans-serif;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(16,38,28,0.35);
}

.pb-overlay {
  position: fixed;
  inset: 0;
  background: rgba(16,38,28,0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 50;
}
@media (min-width: 640px) {
  .pb-overlay { align-items: center; }
}
.pb-modal {
  background: var(--chalk);
  width: 100%;
  max-width: 440px;
  border-radius: 16px 16px 0 0;
  padding: 18px 18px 22px;
  max-height: 88vh;
  overflow-y: auto;
  font-family: 'Inter', sans-serif;
}
@media (min-width: 640px) {
  .pb-modal { border-radius: 16px; }
}
.pb-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.pb-modal-head h2 {
  font-family: 'Oswald', sans-serif;
  font-size: 19px;
  font-weight: 600;
  margin: 0;
  color: var(--pitch-mid);
}

.pb-form { display: flex; flex-direction: column; gap: 12px; }
.pb-form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: #45554B;
}
.pb-optional { font-weight: 400; opacity: 0.6; }
.pb-form input, .pb-form select, .pb-form textarea {
  font-family: 'Inter', sans-serif;
  font-size: 14.5px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--pitch-line);
  background: #fff;
  color: var(--charcoal);
}
.pb-form-row { display: flex; gap: 10px; }
.pb-form-row label { flex: 1; }

.pb-inline-warning {
  color: var(--clay);
  font-size: 12.5px;
  margin-top: -6px;
}

.pb-conflict-box {
  background: #FDEDE7;
  border: 1px solid #F0C4B4;
  border-radius: 9px;
  padding: 10px 12px;
  display: flex;
  gap: 9px;
  font-size: 12.5px;
  color: #8C3A1E;
}
.pb-conflict-box strong { display: block; margin-bottom: 2px; }

.pb-btn-primary {
  background: var(--pitch-mid);
  color: var(--chalk);
  border: none;
  border-radius: 9px;
  padding: 11px;
  font-weight: 600;
  font-size: 14.5px;
  cursor: pointer;
}
.pb-btn-primary:disabled { opacity: 0.6; }
.pb-submit { margin-top: 4px; }

.pb-btn-danger {
  background: #FDEDE7;
  color: #A3401F;
  border: 1px solid #F0C4B4;
  border-radius: 9px;
  padding: 10px;
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 10px;
}
.pb-btn-ghost {
  background: transparent;
  border: 1px solid var(--pitch-line);
  border-radius: 9px;
  padding: 8px 12px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  color: var(--charcoal);
  display: flex;
  align-items: center;
  gap: 5px;
}
.pb-confirm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 13px;
}

.pb-detail { display: flex; flex-direction: column; gap: 12px; margin-bottom: 6px; }
.pb-detail-row { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }
.pb-detail-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #7C8B81;
  font-weight: 600;
}
.pb-coach-chip { display: flex; align-items: center; gap: 5px; }

.pb-manage-note { font-size: 12.5px; color: #6B7C71; margin: 0 0 12px; }
.pb-pitch-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.pb-pitch-row { display: flex; gap: 8px; align-items: center; }
.pb-pitch-row input {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--pitch-line);
  font-size: 14px;
}
.pb-add-pitch-row { display: flex; gap: 8px; margin-bottom: 14px; }
.pb-add-pitch-row input {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--pitch-line);
  font-size: 14px;
}
`;
