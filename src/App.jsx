import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Plus,
  X,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Settings2,
  AlertTriangle,
  Users,
  MapPin,
  Download,
  CalendarRange,
  Grid3x3,
  ClipboardCheck,
  Lock,
  Pencil,
  FileSpreadsheet,
} from "lucide-react";
import jsPDF from "jspdf";
import * as XLSX from "xlsx";
import { supabase, supabaseConfigured } from "./supabaseClient";

// ---------- constants ----------

const DAY_START = 17;  // 17:00 (5pm)
const DAY_END = 22;    // 22:00
const SLOT_MIN = 30;   // grid resolution in minutes
const PITCH_COLORS = ["#C8102E", "#1C1C1C", "#8C1D25", "#4A4A4A", "#A11D2E", "#2B2B2B"];
const REPEAT_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12];

const DEFAULT_PITCHES = [
  { id: "p1", name: "Main Pitch" },
  { id: "p2", name: "Training Pitch" },
];

const DEFAULT_TEAMS = [
  { id: "t1", name: "U13 Boys Training" },
  { id: "t2", name: "U12 Girls Training" },
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

function sectionsConflict(a, b) {
  if (a === "full" || b === "full" || !a || !b) return true;
  return a === b;
}

const SECTION_LABELS = { full: "Full pitch", half_1: "Half 1", half_2: "Half 2" };

// ---------- month PDF export ----------

function buildMonthPdf(monthValue, clubName, pitches, bookings) {
  const [yearStr, monthStr] = monthValue.split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;

  const monthBookings = bookings
    .filter((b) => {
      const d = new Date(b.date + "T00:00:00");
      return d.getFullYear() === year && d.getMonth() === monthIndex;
    })
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  const pitchName = (id) => pitches.find((p) => p.id === id)?.name || "Pitch";
  const monthLabel = new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const marginX = 44;
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 54;

  function ensureRoom(next) {
    if (y + next > pageHeight - 40) {
      doc.addPage();
      y = 54;
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(clubName, marginX, y);
  y += 20;
  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");
  doc.text(`Pitch bookings — ${monthLabel}`, marginX, y);
  y += 10;
  doc.setDrawColor(200, 16, 46);
  doc.setLineWidth(1.2);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 22;

  if (!monthBookings.length) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(11);
    doc.text("No bookings recorded for this month.", marginX, y);
  } else {
    let currentDate = null;
    for (const b of monthBookings) {
      if (b.date !== currentDate) {
        currentDate = b.date;
        ensureRoom(28);
        y += 8;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        const label = new Date(b.date + "T00:00:00").toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
        });
        doc.text(label, marginX, y);
        y += 16;
      }
      ensureRoom(16);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      const time = `${minutesToLabel(timeToMinutes(b.start))}\u2013${minutesToLabel(timeToMinutes(b.end))}`;
      doc.text(time, marginX + 10, y);
      const pitchLabel =
        b.section && b.section !== "full"
          ? `${pitchName(b.pitchId)} (${b.section === "half_1" ? "Half 1" : "Half 2"})`
          : pitchName(b.pitchId);
      doc.text(pitchLabel, marginX + 90, y);
      const typeTag = b.sessionType === "match" ? "Match" : "Training";
      const teamLabel =
        b.status === "pending"
          ? `${b.team} (${b.coach}) — ${typeTag} — PENDING`
          : `${b.team} (${b.coach}) — ${typeTag}`;
      doc.text(teamLabel, marginX + 230, y);
      y += 15;
    }
  }

  doc.save(`pitch-bookings-${monthValue}.pdf`);
}

// ---------- month Excel export ----------

function buildMonthExcel(monthValue, clubName, pitches, bookings) {
  const [yearStr, monthStr] = monthValue.split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;

  const monthBookings = bookings
    .filter((b) => {
      const d = new Date(b.date + "T00:00:00");
      return d.getFullYear() === year && d.getMonth() === monthIndex;
    })
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  const pitchName = (id) => pitches.find((p) => p.id === id)?.name || "Pitch";
  const monthLabel = new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const header = ["Date", "Day", "Start", "End", "Pitch", "Section", "Type", "Team / Session", "Coach", "Status", "Notes"];
  const rows = monthBookings.map((b) => {
    const d = new Date(b.date + "T00:00:00");
    return [
      b.date,
      d.toLocaleDateString(undefined, { weekday: "long" }),
      minutesToLabel(timeToMinutes(b.start)),
      minutesToLabel(timeToMinutes(b.end)),
      pitchName(b.pitchId),
      SECTION_LABELS[b.section] || "Full pitch",
      b.sessionType === "match" ? "Match" : "Training",
      b.team,
      b.coach,
      b.status === "pending" ? "Pending" : "Approved",
      b.notes || "",
    ];
  });

  const sheetData = [[`${clubName} — Pitch bookings — ${monthLabel}`], [], header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);

  ws["!cols"] = [
    { wch: 12 }, { wch: 11 }, { wch: 8 }, { wch: 8 },
    { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 24 }, { wch: 16 }, { wch: 10 }, { wch: 28 },
  ];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Bookings");
  XLSX.writeFile(wb, `pitch-bookings-${monthValue}.xlsx`);
}

// ---------- Approval result screen (landed on from an email link) ----------

function ApprovalResultScreen({ params }) {
  const configs = {
    approved: { title: "Booking approved ✅", tone: "good", body: params.detail },
    rejected: { title: "Booking rejected", tone: "warn", body: params.detail },
    clash: {
      title: "Clashes with an approved booking",
      tone: "warn",
      body: (
        <>
          <p>{params.detail}</p>
          <p>
            This would clash with <strong>{params.clashDetail}</strong>, already approved on the same pitch.
          </p>
          <p>Open the app's Approvals screen to review and decide — this link won't auto-approve over a clash.</p>
        </>
      ),
    },
    already: {
      title: "Already actioned",
      tone: "warn",
      body: (
        <>
          <p>
            This request was already <strong>{params.status}</strong>.
          </p>
          <p>{params.detail}</p>
        </>
      ),
    },
    notfound: { title: "Not found", tone: "bad", body: "This booking no longer exists." },
    invalid: { title: "Invalid link", tone: "bad", body: "This link isn't valid for this booking." },
    badlink: { title: "Bad link", tone: "bad", body: "This link is missing information and can't be used." },
  };
  const cfg = configs[params.approval] || {
    title: "Done",
    tone: "good",
    body: "Action completed.",
  };
  const color = cfg.tone === "good" ? "#1B4332" : cfg.tone === "warn" ? "#8A5A00" : "#A3401F";

  return (
    <div style={{ minHeight: "100vh" }} className="pb-root">
      <style>{css}</style>
      <div className="pb-result-wrap">
        <div className="pb-result-card">
          <div className="pb-result-head" style={{ background: color }}>
            <img src="/crest.png" alt="" className="pb-crest-img" />
            <strong>Pitch Book</strong>
          </div>
          <div className="pb-result-body">
            <h1 style={{ color }}>{cfg.title}</h1>
            {typeof cfg.body === "string" ? <p>{cfg.body}</p> : cfg.body}
            <a className="pb-btn-primary pb-result-link" href={window.location.pathname}>
              Open Pitch Book
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PitchBooker() {
  // If we've just been redirected here from an email Approve/Reject link,
  // show a small result screen instead of the main calendar. This is
  // computed once from the URL, not app state, so it's safe to check
  // before any hooks run.
  const approvalParams = (() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("approval") ? Object.fromEntries(params.entries()) : null;
  })();
  if (approvalParams) {
    return <ApprovalResultScreen params={approvalParams} />;
  }

  const [pitches, setPitches] = useState(null);
  const [teams, setTeams] = useState(null);
  const [coaches, setCoaches] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => toISODate(new Date()));

  const [modalOpen, setModalOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [adminPasscode, setAdminPasscode] = useState(null); // held in memory only, never persisted
  const [managePasscode, setManagePasscode] = useState(null); // separate passcode, just for Pitches/Coaches
  const [viewMode, setViewMode] = useState("day"); // "day" | "week"
  const [detailBooking, setDetailBooking] = useState(null);
  const [editingBooking, setEditingBooking] = useState(null);
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
      status: row.status || "approved",
      sessionType: row.session_type || "match",
      section: row.section || "full",
      createdAt: row.created_at,
    };
  }

  const fetchPitches = useCallback(async () => {
    const { data, error: err } = await supabase.from("pitches").select("*").order("sort_order", { ascending: true });
    if (err) throw err;
    return (data || []).map((r) => ({ id: r.id, name: r.name }));
  }, []);

  // Teams and coaches are optional add-on tables (see migration_teams_coaches.sql).
  // If they haven't been created yet, fail quietly to an empty list rather than
  // breaking the whole app.
  const fetchTeams = useCallback(async () => {
    try {
      const { data, error: err } = await supabase.from("teams").select("*").order("sort_order", { ascending: true });
      if (err) throw err;
      return (data || []).map((r) => ({ id: r.id, name: r.name }));
    } catch {
      return [];
    }
  }, []);

  const fetchCoaches = useCallback(async () => {
    try {
      const { data, error: err } = await supabase.from("coaches").select("*").order("sort_order", { ascending: true });
      if (err) throw err;
      return (data || []).map((r) => ({ id: r.id, name: r.name, email: r.email || "" }));
    } catch {
      return [];
    }
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
      setTeams([]);
      setCoaches([]);
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

        let t = await fetchTeams();
        if (!t.length) {
          try {
            await supabase.from("teams").insert(
              DEFAULT_TEAMS.map((team, i) => ({ id: team.id, name: team.name, sort_order: i }))
            );
            t = await fetchTeams();
          } catch {
            // teams table may not exist yet if migration hasn't been run - fine, just empty
          }
        }
        setTeams(t);
        setCoaches(await fetchCoaches());

        const b = await fetchBookings();
        setBookings(b);
      } catch (e) {
        console.error(e);
        setError("Couldn't load the pitch book. Check your connection and try reloading.");
        setPitches(DEFAULT_PITCHES);
        setTeams([]);
        setCoaches([]);
        setBookings([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchPitches, fetchTeams, fetchCoaches, fetchBookings]);

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
      .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, async () => {
        try {
          setTeams(await fetchTeams());
        } catch {
          // ignore
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "coaches" }, async () => {
        try {
          setCoaches(await fetchCoaches());
        } catch {
          // ignore
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchBookings, fetchPitches, fetchTeams, fetchCoaches]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  // Diff the edited pitch list against what's stored and push only the changes.
  const savePitches = useCallback(async (next, passcode) => {
    if (!supabaseConfigured) {
      setPitches(next);
      return true;
    }
    try {
      const upserts = next.map((p, i) => ({ id: p.id, name: p.name, sort_order: i }));
      const { data, error: err } = await supabase.rpc("admin_save_pitches", {
        new_pitches: upserts,
        input_passcode: passcode,
      });
      if (err) throw err;
      if (!data) return false;
      setPitches(await fetchPitches());
      return true;
    } catch (e) {
      console.error(e);
      setError("Couldn't save pitch changes.");
      return false;
    }
  }, [fetchPitches]);

  const saveTeams = useCallback(
    async (next) => {
      const previous = teams || [];
      setTeams(next);
      if (!supabaseConfigured) return;
      try {
        const nextIds = new Set(next.map((t) => t.id));
        const removed = previous.filter((t) => !nextIds.has(t.id));
        const upserts = next.map((t, i) => ({ id: t.id, name: t.name, sort_order: i }));
        if (upserts.length) {
          const { error: err } = await supabase.from("teams").upsert(upserts);
          if (err) throw err;
        }
        for (const t of removed) {
          const { error: err } = await supabase.from("teams").delete().eq("id", t.id);
          if (err) throw err;
        }
      } catch (e) {
        console.error(e);
        setError("Couldn't save team changes. Have you run migration_teams_coaches.sql yet?");
      }
    },
    [teams]
  );

  const saveCoaches = useCallback(async (next, passcode) => {
    if (!supabaseConfigured) {
      setCoaches(next);
      return true;
    }
    try {
      const upserts = next.map((c, i) => ({ id: c.id, name: c.name, sort_order: i }));
      const { data, error: err } = await supabase.rpc("admin_save_coaches", {
        new_coaches: upserts,
        input_passcode: passcode,
      });
      if (err) throw err;
      if (!data) return false;
      setCoaches(await fetchCoaches());
      return true;
    } catch (e) {
      console.error(e);
      setError("Couldn't save coach changes.");
      return false;
    }
  }, [fetchCoaches]);

  async function verifyManagePasscode(passcode) {
    if (!supabaseConfigured) return false;
    try {
      const { data, error: err } = await supabase.rpc("verify_manage_passcode", { input_passcode: passcode });
      if (err) throw err;
      return Boolean(data);
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const dayBookings = useMemo(() => {
    if (!bookings) return [];
    return bookings
      .filter((b) => b.date === selectedDate && b.status !== "rejected" && b.status !== "cancelled")
      .sort((a, b) => a.start.localeCompare(b.start));
  }, [bookings, selectedDate]);

  const visibleBookings = useMemo(() => {
    if (!bookings) return [];
    return bookings.filter((b) => b.status !== "rejected" && b.status !== "cancelled");
  }, [bookings]);

  const pendingBookings = useMemo(() => {
    if (!bookings) return [];
    return bookings.filter((b) => b.status === "pending").sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  }, [bookings]);

  const isToday = selectedDate === toISODate(new Date());

  function findConflict(list, pitchId, date, start, end, excludeId, section) {
    return (list || []).find(
      (b) =>
        b.id !== excludeId &&
        b.pitchId === pitchId &&
        b.date === date &&
        sectionsConflict(section, b.section) &&
        overlaps(timeToMinutes(start), timeToMinutes(end), timeToMinutes(b.start), timeToMinutes(b.end))
    );
  }

  async function handleSaveBooking(form, editingId) {
    if (!supabaseConfigured) {
      return { error: null, offline: true };
    }

    const dates =
      !editingId && form.repeatWeeks > 1
        ? Array.from({ length: form.repeatWeeks }, (_, i) => toISODate(addDays(new Date(form.date + "T00:00:00"), i * 7)))
        : [form.date];

    try {
      // Re-check against the live table right before writing, so two coaches
      // tapping "confirm" seconds apart can't both grab the same slot.
      const { data, error: fetchErr } = await supabase
        .from("bookings")
        .select("*")
        .eq("pitch_id", form.pitchId)
        .in("date", dates);
      if (fetchErr) throw fetchErr;
      const live = data.map(rowToBooking).filter((b) => b.status !== "rejected" && b.status !== "cancelled");

      if (dates.length === 1) {
        const liveConflict = findConflict(live, form.pitchId, form.date, form.start, form.end, editingId, form.section);
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
          session_type: form.sessionType,
          section: form.section,
        };

        if (editingId) {
          // An edit is really "retire the old request, submit the change as a
          // new one" - a different time/pitch needs its own approval, same as
          // any other request.
          const { error: insErr } = await supabase.from("bookings").insert({ id: genId(), status: "pending", ...row });
          if (insErr) throw insErr;
          const { error: cancelErr } = await supabase
            .from("bookings")
            .update({ status: "cancelled" })
            .eq("id", editingId);
          if (cancelErr) throw cancelErr;
        } else {
          const { error: err } = await supabase.from("bookings").insert({ id: genId(), status: "pending", ...row });
          if (err) throw err;
        }

        setBookings(await fetchBookings());
        return { error: null };
      }

      // Recurring booking: book every week that's free, skip and report any that clash.
      const skipped = [];
      const toInsert = [];
      for (const d of dates) {
        const clash = findConflict(live, form.pitchId, d, form.start, form.end, null, form.section);
        if (clash) {
          skipped.push({ date: d, conflict: clash });
        } else {
          toInsert.push({
            id: genId(),
            pitch_id: form.pitchId,
            date: d,
            start_time: form.start,
            end_time: form.end,
            coach: form.coach,
            team: form.team,
            notes: form.notes || "",
            status: "pending",
            session_type: form.sessionType,
            section: form.section,
          });
        }
      }

      if (toInsert.length) {
        const { error: err } = await supabase.from("bookings").insert(toInsert);
        if (err) throw err;
        setBookings(await fetchBookings());
      }

      return { error: null, series: { totalWeeks: dates.length, booked: toInsert.length, skipped } };
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
      const { error: err } = await supabase.from("bookings").update({ status: "cancelled" }).eq("id", id);
      if (err) throw err;
      setBookings(await fetchBookings());
    } catch (e) {
      console.error(e);
      setError("Couldn't cancel the booking. Try again.");
    } finally {
      setDetailBooking(null);
    }
  }

  // ---- admin approval ----
  async function verifyPasscode(passcode) {
    if (!supabaseConfigured) return false;
    try {
      const { data, error: err } = await supabase.rpc("verify_admin_passcode", { input_passcode: passcode });
      if (err) throw err;
      return Boolean(data);
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  async function approveBooking(id, passcode) {
    try {
      const { data, error: err } = await supabase.rpc("approve_booking", { target_id: id, input_passcode: passcode });
      if (err) throw err;
      if (data) setBookings(await fetchBookings());
      return Boolean(data);
    } catch (e) {
      console.error(e);
      setError("Couldn't approve the booking.");
      return false;
    }
  }

  async function rejectBooking(id, passcode) {
    try {
      const { data, error: err } = await supabase.rpc("reject_booking", { target_id: id, input_passcode: passcode });
      if (err) throw err;
      if (data) setBookings(await fetchBookings());
      return Boolean(data);
    } catch (e) {
      console.error(e);
      setError("Couldn't reject the booking.");
      return false;
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
            <img src="/crest.png" alt="" className="pb-crest-img" />
          </div>
          <div>
            <h1>Drogheda Town FC</h1>
            <p className="pb-sub">Pitch booking — see who's on before you turn up.</p>
          </div>
          <button className="pb-icon-btn pb-approvals-btn" onClick={() => setApprovalsOpen(true)} aria-label="Approvals">
            <ClipboardCheck size={18} />
            {pendingBookings.length > 0 && <span className="pb-badge">{pendingBookings.length}</span>}
          </button>
          <button className="pb-icon-btn" onClick={() => setPdfOpen(true)} aria-label="Export bookings">
            <Download size={18} />
          </button>
          <button className="pb-icon-btn" onClick={() => setManageOpen(true)} aria-label="Manage pitches, teams and coaches">
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

      <div className="pb-view-toggle">
        <button
          className={`pb-toggle-btn ${viewMode === "day" ? "active" : ""}`}
          onClick={() => setViewMode("day")}
        >
          <Grid3x3 size={14} /> Day &amp; pitches
        </button>
        <button
          className={`pb-toggle-btn ${viewMode === "week" ? "active" : ""}`}
          onClick={() => setViewMode("week")}
        >
          <CalendarRange size={14} /> Week per page
        </button>
      </div>

      <div className="pb-week-nav">
        <button className="pb-icon-btn" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">
          <ChevronLeft size={18} />
        </button>
        {viewMode === "day" ? (
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
        ) : (
          <div className="pb-week-range-label">
            {fmtDayLabel(weekDays[0])} – {fmtDayLabel(weekDays[6])}
          </div>
        )}
        <button className="pb-icon-btn" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">
          <ChevronRight size={18} />
        </button>
      </div>

      {viewMode === "day" && (
        <div className="pb-date-heading">
          {new Date(selectedDate + "T00:00:00").toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </div>
      )}

      {pitches.length === 0 ? (
        <div className="pb-empty">
          <MapPin size={28} />
          <p>No pitches set up yet.</p>
          <button className="pb-btn-primary" onClick={() => setManageOpen(true)}>
            Add a pitch
          </button>
        </div>
      ) : viewMode === "day" ? (
        <ScheduleGrid
          pitches={pitches}
          dayBookings={dayBookings}
          isToday={isToday}
          now={now}
          onSelectBooking={setDetailBooking}
        />
      ) : (
        <WeekAgenda weekDays={weekDays} pitches={pitches} bookings={visibleBookings} onSelectBooking={setDetailBooking} />
      )}

      <button
        className="pb-fab"
        onClick={() => {
          setEditingBooking(null);
          setModalOpen(true);
        }}
      >
        <Plus size={20} />
        <span>Book pitch</span>
      </button>

      {modalOpen && (
        <BookingModal
          pitches={pitches}
          teams={teams || []}
          coaches={coaches || []}
          defaultDate={selectedDate}
          initial={editingBooking}
          onClose={() => {
            setModalOpen(false);
            setEditingBooking(null);
          }}
          onSave={handleSaveBooking}
        />
      )}

      {detailBooking && (
        <DetailModal
          booking={detailBooking}
          pitch={pitches.find((p) => p.id === detailBooking.pitchId)}
          onClose={() => setDetailBooking(null)}
          onDelete={() => handleDelete(detailBooking.id)}
          onEdit={() => {
            setEditingBooking(detailBooking);
            setDetailBooking(null);
            setModalOpen(true);
          }}
        />
      )}

      {manageOpen && (
        <ManageListsModal
          pitches={pitches}
          teams={teams || []}
          coaches={coaches || []}
          onClose={() => setManageOpen(false)}
          onSavePitches={savePitches}
          onSaveTeams={saveTeams}
          onSaveCoaches={saveCoaches}
          managePasscode={managePasscode}
          onUnlockManage={async (code) => {
            const ok = await verifyManagePasscode(code);
            if (ok) setManagePasscode(code);
            return ok;
          }}
        />
      )}

      {pdfOpen && (
        <MonthExportModal
          defaultMonth={selectedDate.slice(0, 7)}
          pitches={pitches}
          bookings={visibleBookings}
          onClose={() => setPdfOpen(false)}
        />
      )}

      {approvalsOpen && (
        <ApprovalsModal
          pendingBookings={pendingBookings}
          allBookings={bookings || []}
          pitches={pitches}
          adminPasscode={adminPasscode}
          onUnlock={async (code) => {
            const ok = await verifyPasscode(code);
            if (ok) setAdminPasscode(code);
            return ok;
          }}
          onApprove={(id) => approveBooking(id, adminPasscode)}
          onReject={(id) => rejectBooking(id, adminPasscode)}
          onClose={() => setApprovalsOpen(false)}
        />
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
                    const pending = b.status === "pending";
                    return (
                      <button
                        key={b.id}
                        className={`pb-booking-block ${pending ? "pending" : ""}`}
                        style={{ top, height, background: color }}
                        onClick={() => onSelectBooking(b)}
                      >
                        <span className="pb-block-time">
                          {minutesToLabel(timeToMinutes(b.start))}–{minutesToLabel(timeToMinutes(b.end))}
                          {pending && <span className="pb-pending-tag">PENDING</span>}
                        </span>
                        <span className="pb-block-team">
                          {b.team}
                          {b.section && b.section !== "full" ? ` (${SECTION_LABELS[b.section]})` : ""}
                        </span>
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

// ---------- Week agenda (week-per-page view) ----------

function WeekAgenda({ weekDays, pitches, bookings, onSelectBooking }) {
  return (
    <div className="pb-week-agenda">
      {weekDays.map((d) => {
        const iso = toISODate(d);
        const today = iso === toISODate(new Date());
        const items = bookings
          .filter((b) => b.date === iso)
          .sort((a, b) => a.start.localeCompare(b.start));
        return (
          <div key={iso} className={`pb-week-day-card ${today ? "today" : ""}`}>
            <div className="pb-week-day-head">{fmtDayLabel(d)}</div>
            {items.length === 0 ? (
              <div className="pb-week-day-empty">No bookings</div>
            ) : (
              <ul className="pb-week-day-list">
                {items.map((b) => {
                  const idx = pitches.findIndex((p) => p.id === b.pitchId);
                  const color = PITCH_COLORS[(idx < 0 ? 0 : idx) % PITCH_COLORS.length];
                  return (
                    <li key={b.id}>
                      <button className="pb-week-item" onClick={() => onSelectBooking(b)}>
                        <span className="pb-week-dot" style={{ background: color }} />
                        <span className="pb-week-time">
                          {minutesToLabel(timeToMinutes(b.start))}–{minutesToLabel(timeToMinutes(b.end))}
                          {b.status === "pending" && <span className="pb-pending-tag">PENDING</span>}
                        </span>
                        <span className="pb-week-pitch">{pitches.find((p) => p.id === b.pitchId)?.name}</span>
                        <span className="pb-week-team">
                          {b.team}
                          {b.section && b.section !== "full" ? ` (${SECTION_LABELS[b.section]})` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Month PDF modal ----------

function MonthExportModal({ defaultMonth, pitches, bookings, onClose }) {
  const [month, setMonth] = useState(defaultMonth);

  function downloadPdf() {
    buildMonthPdf(month, "Drogheda Town FC", pitches, bookings);
  }

  function downloadExcel() {
    buildMonthExcel(month, "Drogheda Town FC", pitches, bookings);
  }

  return (
    <div className="pb-overlay" onClick={onClose}>
      <div className="pb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pb-modal-head">
          <h2>Export bookings</h2>
          <button className="pb-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="pb-form">
          <label>
            Month
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <p className="pb-repeat-hint">
            Both list every booking that month, grouped by date, across all pitches.
          </p>
          <button className="pb-btn-primary pb-submit" onClick={downloadPdf}>
            <Download size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
            Download PDF
          </button>
          <button className="pb-btn-ghost pb-submit" onClick={downloadExcel}>
            <FileSpreadsheet size={16} />
            Download Excel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Booking modal ----------

function BookingModal({ pitches, teams, coaches, defaultDate, initial, onClose, onSave }) {
  const isEdit = Boolean(initial);
  const [pitchId, setPitchId] = useState(initial?.pitchId || pitches[0]?.id || "");
  const [date, setDate] = useState(initial?.date || defaultDate);
  const [start, setStart] = useState(initial?.start || "18:00");
  const [end, setEnd] = useState(initial?.end || "19:00");
  const [coach, setCoach] = useState(initial?.coach || coaches[0]?.name || "");
  const [team, setTeam] = useState(initial?.team || teams[0]?.name || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [sessionType, setSessionType] = useState(initial?.sessionType || "training");
  const [section, setSection] = useState(initial?.section || "full");
  const [repeatWeeks, setRepeatWeeks] = useState(1);
  const [conflict, setConflict] = useState(null);
  const [seriesResult, setSeriesResult] = useState(null);
  const [saving, setSaving] = useState(false);

  const invalidTime = timeToMinutes(end) <= timeToMinutes(start);

  function handleSessionTypeChange(next) {
    setSessionType(next);
    if (next === "match") setSection("full");
  }

  async function submit(e) {
    e.preventDefault();
    if (!coach.trim() || !team.trim() || invalidTime) return;
    setSaving(true);
    setConflict(null);
    setSeriesResult(null);
    const result = await onSave(
      {
        pitchId,
        date,
        start,
        end,
        coach: coach.trim(),
        team: team.trim(),
        notes: notes.trim(),
        repeatWeeks,
        sessionType,
        section,
      },
      initial?.id || null
    );
    setSaving(false);
    if (result.error) {
      setConflict(result.error);
    } else if (result.series) {
      setSeriesResult(result.series);
    } else {
      onClose();
    }
  }

  return (
    <div className="pb-overlay" onClick={onClose}>
      <div className="pb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pb-modal-head">
          <h2>{isEdit ? "Edit booking" : "Book a pitch"}</h2>
          <button className="pb-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {seriesResult ? (
          <div className="pb-series-summary">
            <p>
              Booked <strong>{seriesResult.booked}</strong> of {seriesResult.totalWeeks} weeks on{" "}
              {pitches.find((p) => p.id === pitchId)?.name}, {minutesToLabel(timeToMinutes(start))}–
              {minutesToLabel(timeToMinutes(end))}.
            </p>
            {seriesResult.skipped.length > 0 && (
              <div className="pb-conflict-box">
                <AlertTriangle size={16} />
                <div>
                  <strong>
                    {seriesResult.skipped.length} week{seriesResult.skipped.length > 1 ? "s" : ""} already booked —
                    skipped:
                  </strong>
                  <ul className="pb-skip-list">
                    {seriesResult.skipped.map((s) => (
                      <li key={s.date}>
                        {new Date(s.date + "T00:00:00").toLocaleDateString(undefined, {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                        })}{" "}
                        — {s.conflict.team} ({s.conflict.coach})
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <button className="pb-btn-primary pb-submit" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
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
            <div className="pb-form-row">
              <label>
                Type
                <select value={sessionType} onChange={(e) => handleSessionTypeChange(e.target.value)}>
                  <option value="training">Training</option>
                  <option value="match">Match</option>
                </select>
              </label>
              {sessionType === "training" && (
                <label>
                  Pitch section
                  <select value={section} onChange={(e) => setSection(e.target.value)}>
                    <option value="full">Full pitch</option>
                    <option value="half_1">Half 1</option>
                    <option value="half_2">Half 2</option>
                  </select>
                </label>
              )}
            </div>
            {sessionType === "training" && section !== "full" && (
              <p className="pb-repeat-hint">
                Booking {SECTION_LABELS[section]} only — the other half stays free for someone else to book at the
                same time.
              </p>
            )}
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
              {teams.length === 0 ? (
                <p className="pb-inline-warning">
                  No teams set up yet — add one via the gear icon first.
                </p>
              ) : (
                <select value={team} onChange={(e) => setTeam(e.target.value)} required>
                  {teams.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label>
              Coach
              {coaches.length === 0 ? (
                <p className="pb-inline-warning">
                  No coaches set up yet — add one via the gear icon first.
                </p>
              ) : (
                <select value={coach} onChange={(e) => setCoach(e.target.value)} required>
                  {coaches.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
            {!isEdit && (
              <label>
                Repeat weekly
                <select value={repeatWeeks} onChange={(e) => setRepeatWeeks(Number(e.target.value))}>
                  <option value={1}>Just this week</option>
                  {REPEAT_OPTIONS.filter((n) => n > 1).map((n) => (
                    <option key={n} value={n}>
                      {n} weeks (same day &amp; time)
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!isEdit && repeatWeeks > 1 && (
              <p className="pb-repeat-hint">
                Books every {new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" })} for{" "}
                {repeatWeeks} weeks from {new Date(date + "T00:00:00").toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}
                . Any week that's already booked will be skipped and listed for you.
              </p>
            )}
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
              {saving
                ? "Saving…"
                : isEdit
                ? "Save change (needs re-approval)"
                : repeatWeeks > 1
                ? `Confirm ${repeatWeeks} bookings`
                : "Confirm booking"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------- Detail modal ----------

function DetailModal({ booking, pitch, onClose, onDelete, onEdit }) {
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
            <span className="pb-detail-label">Status</span>
            <span className={`pb-status-tag ${booking.status === "pending" ? "pending" : "approved"}`}>
              {booking.status === "pending" ? "Pending approval" : "Approved"}
            </span>
          </div>
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
            <span className="pb-detail-label">Type</span>
            <span>
              {booking.sessionType === "match" ? "Match" : "Training"}
              {booking.section && booking.section !== "full" ? ` — ${SECTION_LABELS[booking.section]}` : ""}
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
          <div className="pb-detail-actions">
            <button className="pb-btn-ghost pb-detail-edit" onClick={onEdit}>
              <Pencil size={15} /> Edit / move
            </button>
            <button className="pb-btn-danger" onClick={() => setConfirming(true)}>
              <Trash2 size={16} /> Cancel booking
            </button>
          </div>
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

// ---------- Approvals modal ----------

function ApprovalsModal({ pendingBookings, allBookings, pitches, adminPasscode, onUnlock, onApprove, onReject, onClose }) {
  const [passcodeInput, setPasscodeInput] = useState("");
  const [unlockError, setUnlockError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmOverride, setConfirmOverride] = useState(null); // booking id needing a clash override

  async function submitPasscode(e) {
    e.preventDefault();
    setChecking(true);
    setUnlockError(false);
    const ok = await onUnlock(passcodeInput);
    setChecking(false);
    if (!ok) setUnlockError(true);
  }

  function pitchName(id) {
    return pitches.find((p) => p.id === id)?.name || "Pitch";
  }

  function findApprovedClash(booking) {
    return allBookings.find(
      (b) =>
        b.id !== booking.id &&
        b.status === "approved" &&
        b.pitchId === booking.pitchId &&
        b.date === booking.date &&
        sectionsConflict(booking.section, b.section) &&
        overlaps(timeToMinutes(booking.start), timeToMinutes(booking.end), timeToMinutes(b.start), timeToMinutes(b.end))
    );
  }

  async function handleApprove(booking) {
    const clash = findApprovedClash(booking);
    if (clash && confirmOverride !== booking.id) {
      setConfirmOverride(booking.id);
      return;
    }
    setBusyId(booking.id);
    await onApprove(booking.id);
    setBusyId(null);
    setConfirmOverride(null);
  }

  async function handleReject(booking) {
    setBusyId(booking.id);
    await onReject(booking.id);
    setBusyId(null);
  }

  return (
    <div className="pb-overlay" onClick={onClose}>
      <div className="pb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pb-modal-head">
          <h2>Approvals</h2>
          <button className="pb-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {!adminPasscode ? (
          <form onSubmit={submitPasscode} className="pb-form">
            <p className="pb-manage-note">
              <Lock size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
              Enter the admin passcode to review pending requests.
            </p>
            <label>
              Passcode
              <input
                type="password"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                autoFocus
              />
            </label>
            {unlockError && <div className="pb-inline-warning">That passcode isn't right.</div>}
            <button type="submit" className="pb-btn-primary pb-submit" disabled={checking}>
              {checking ? "Checking…" : "Unlock"}
            </button>
          </form>
        ) : pendingBookings.length === 0 ? (
          <p className="pb-manage-note">No pending requests right now — you're all caught up.</p>
        ) : (
          <div className="pb-approvals-list">
            {pendingBookings.map((b) => {
              const clash = findApprovedClash(b);
              const busy = busyId === b.id;
              return (
                <div key={b.id} className="pb-approval-card">
                  <div className="pb-approval-info">
                    <div className="pb-approval-when">
                      {new Date(b.date + "T00:00:00").toLocaleDateString(undefined, {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                      })}
                      , {minutesToLabel(timeToMinutes(b.start))}–{minutesToLabel(timeToMinutes(b.end))} ·{" "}
                      {pitchName(b.pitchId)}
                    </div>
                    <div className="pb-approval-team">
                      {b.team}
                      {b.section && b.section !== "full" ? ` (${SECTION_LABELS[b.section]})` : ""}
                    </div>
                    <div className="pb-approval-type">{b.sessionType === "match" ? "Match" : "Training"}</div>
                    <div className="pb-approval-coach">Requested by {b.coach}</div>
                    {b.notes && <div className="pb-approval-notes">{b.notes}</div>}
                  </div>
                  {clash && (
                    <div className="pb-conflict-box">
                      <AlertTriangle size={16} />
                      <div>
                        <strong>Clashes with an approved booking</strong>
                        <div>
                          {clash.team} ({clash.coach}), {minutesToLabel(timeToMinutes(clash.start))}–
                          {minutesToLabel(timeToMinutes(clash.end))}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="pb-approval-actions">
                    <button
                      className="pb-btn-primary pb-approval-approve"
                      onClick={() => handleApprove(b)}
                      disabled={busy}
                    >
                      {busy ? "…" : clash && confirmOverride === b.id ? "Approve anyway" : "Approve"}
                    </button>
                    <button className="pb-btn-danger pb-approval-reject" onClick={() => handleReject(b)} disabled={busy}>
                      Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Manage lists modal (Pitches / Teams / Coaches) ----------

function SimpleNameListEditor({ items, onSave, passcode, label, labelPlural, placeholder }) {
  const [list, setList] = useState(items);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  function add() {
    const name = newName.trim();
    if (!name) return;
    setList([...list, { id: genId(), name }]);
    setNewName("");
  }

  function remove(id) {
    setList(list.filter((p) => p.id !== id));
  }

  function rename(id, name) {
    setList(list.map((p) => (p.id === id ? { ...p, name } : p)));
  }

  async function save() {
    setSaving(true);
    setSaveError(false);
    const result = await onSave(list, passcode);
    setSaving(false);
    if (result === false) setSaveError(true);
  }

  return (
    <div>
      <div className="pb-pitch-list">
        {list.map((p) => (
          <div key={p.id} className="pb-pitch-row">
            <input value={p.name} onChange={(e) => rename(p.id, e.target.value)} />
            <button className="pb-icon-btn" onClick={() => remove(p.id)} aria-label={`Remove ${label}`}>
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {list.length === 0 && <p className="pb-manage-note">None added yet.</p>}
      </div>
      <div className="pb-add-pitch-row">
        <input
          placeholder={placeholder}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        />
        <button className="pb-btn-ghost" onClick={add}>
          <Plus size={16} /> Add
        </button>
      </div>
      {saveError && <div className="pb-inline-warning">That passcode isn't right — changes weren't saved.</div>}
      <button className="pb-btn-primary pb-submit" onClick={save} disabled={saving}>
        {saving ? "Saving…" : `Save ${labelPlural}`}
      </button>
    </div>
  );
}

function CoachListEditor({ items, onSave, passcode }) {
  const [list, setList] = useState(items);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  function add() {
    const name = newName.trim();
    if (!name) return;
    setList([...list, { id: genId(), name }]);
    setNewName("");
  }

  function remove(id) {
    setList(list.filter((c) => c.id !== id));
  }

  function rename(id, name) {
    setList(list.map((c) => (c.id === id ? { ...c, name } : c)));
  }

  async function save() {
    setSaving(true);
    setSaveError(false);
    const result = await onSave(list, passcode);
    setSaving(false);
    if (result === false) setSaveError(true);
  }

  return (
    <div>
      <div className="pb-pitch-list">
        {list.map((c) => (
          <div key={c.id} className="pb-pitch-row">
            <input value={c.name} placeholder="Name" onChange={(e) => rename(c.id, e.target.value)} />
            <button className="pb-icon-btn" onClick={() => remove(c.id)} aria-label="Remove coach">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {list.length === 0 && <p className="pb-manage-note">None added yet.</p>}
      </div>
      <div className="pb-add-pitch-row">
        <input
          placeholder="Coach name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        />
        <button className="pb-btn-ghost" onClick={add}>
          <Plus size={16} /> Add
        </button>
      </div>
      {saveError && <div className="pb-inline-warning">That passcode isn't right — changes weren't saved.</div>}
      <button className="pb-btn-primary pb-submit" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save coaches"}
      </button>
    </div>
  );
}

function ManageListsModal({
  pitches,
  teams,
  coaches,
  onClose,
  onSavePitches,
  onSaveTeams,
  onSaveCoaches,
  managePasscode,
  onUnlockManage,
}) {
  const [tab, setTab] = useState("pitches");
  const [passInput, setPassInput] = useState("");
  const [passError, setPassError] = useState(false);
  const [checking, setChecking] = useState(false);

  const needsUnlock = (tab === "pitches" || tab === "coaches") && !managePasscode;

  async function submitPasscode(e) {
    e.preventDefault();
    setChecking(true);
    setPassError(false);
    const ok = await onUnlockManage(passInput);
    setChecking(false);
    if (!ok) setPassError(true);
  }

  return (
    <div className="pb-overlay" onClick={onClose}>
      <div className="pb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pb-modal-head">
          <h2>Manage lists</h2>
          <button className="pb-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p className="pb-manage-note">Changes here are visible to everyone using this booker.</p>

        <div className="pb-tab-row">
          <button className={`pb-toggle-btn ${tab === "pitches" ? "active" : ""}`} onClick={() => setTab("pitches")}>
            Pitches
          </button>
          <button className={`pb-toggle-btn ${tab === "teams" ? "active" : ""}`} onClick={() => setTab("teams")}>
            Teams
          </button>
          <button className={`pb-toggle-btn ${tab === "coaches" ? "active" : ""}`} onClick={() => setTab("coaches")}>
            Coaches
          </button>
        </div>

        {needsUnlock ? (
          <form onSubmit={submitPasscode} className="pb-form">
            <p className="pb-manage-note">
              <Lock size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
              Adding or editing {tab} needs the manage passcode.
            </p>
            <label>
              Passcode
              <input type="password" value={passInput} onChange={(e) => setPassInput(e.target.value)} autoFocus />
            </label>
            {passError && <div className="pb-inline-warning">That passcode isn't right.</div>}
            <button type="submit" className="pb-btn-primary pb-submit" disabled={checking}>
              {checking ? "Checking…" : "Unlock"}
            </button>
          </form>
        ) : (
          <>
            {tab === "pitches" && (
              <SimpleNameListEditor
                items={pitches}
                onSave={onSavePitches}
                passcode={managePasscode}
                label="pitch"
                labelPlural="pitches"
                placeholder="New pitch name"
              />
            )}
            {tab === "teams" && (
              <SimpleNameListEditor
                items={teams}
                onSave={onSaveTeams}
                label="team"
                labelPlural="teams"
                placeholder="New team / session name"
              />
            )}
            {tab === "coaches" && (
              <CoachListEditor items={coaches} onSave={onSaveCoaches} passcode={managePasscode} />
            )}
          </>
        )}
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
  --pitch-dark: #0D0D0D;
  --pitch-mid: #C8102E;
  --pitch-line: #DCD5D5;
  --chalk: #F7F5F3;
  --charcoal: #181111;
  --clay: #B45309;
  --amber: #C8102E;
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
  font-size: 21px;
  letter-spacing: 0.4px;
  margin: 0;
  text-transform: uppercase;
}
.pb-sub {
  margin: 2px 0 0;
  font-size: 13px;
  opacity: 0.75;
}
.pb-crest { flex-shrink: 0; }
.pb-crest-img {
  width: 42px;
  height: 42px;
  object-fit: contain;
  display: block;
}

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
  position: relative;
}
.pb-icon-btn:hover { background: rgba(255,255,255,0.16); }
.pb-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  background: var(--pitch-mid);
  color: #fff;
  border: 2px solid var(--pitch-dark);
  border-radius: 999px;
  font-family: 'Inter', sans-serif;
  font-size: 10px;
  font-weight: 700;
  min-width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
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

.pb-view-toggle {
  display: flex;
  gap: 8px;
  padding: 14px 12px 0;
}
.pb-toggle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--pitch-line);
  background: var(--card-bg);
  color: var(--charcoal);
  border-radius: 999px;
  padding: 7px 13px;
  font-family: 'Inter', sans-serif;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.pb-toggle-btn.active {
  background: var(--pitch-dark);
  border-color: var(--pitch-dark);
  color: var(--chalk);
}

.pb-week-range-label {
  flex: 1;
  text-align: center;
  font-family: 'Oswald', sans-serif;
  font-size: 15px;
  font-weight: 500;
  color: var(--charcoal);
}

.pb-week-agenda {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 10px;
  padding: 14px 12px 24px;
  overflow-x: auto;
}
@media (max-width: 760px) {
  .pb-week-agenda {
    grid-template-columns: 1fr;
  }
}
.pb-week-day-card {
  background: var(--card-bg);
  border: 1px solid var(--pitch-line);
  border-radius: 10px;
  padding: 10px;
  min-width: 150px;
}
.pb-week-day-card.today { border-color: var(--pitch-mid); border-width: 1.5px; }
.pb-week-day-head {
  font-family: 'Oswald', sans-serif;
  font-size: 12.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--pitch-mid);
  border-bottom: 1px solid var(--pitch-line);
  padding-bottom: 6px;
  margin-bottom: 8px;
}
.pb-week-day-empty {
  font-size: 12px;
  color: #9A8E8E;
  padding: 4px 0;
}
.pb-week-day-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pb-week-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 3px solid transparent;
  padding: 3px 0 3px 7px;
  cursor: pointer;
  font-family: 'Inter', sans-serif;
}
.pb-week-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 5px;
}
.pb-week-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #7C6B6B;
}
.pb-week-pitch {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--charcoal);
  display: block;
  margin-left: 12px;
}
.pb-week-team {
  font-size: 11px;
  color: #6B5B5B;
  display: block;
  margin-left: 12px;
}

@media print {
  .pb-header, .pb-view-toggle, .pb-week-nav, .pb-fab, .pb-error-banner {
    display: none !important;
  }
  .pb-week-agenda {
    grid-template-columns: repeat(7, 1fr);
  }
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
.pb-booking-block.pending {
  opacity: 0.68;
  background-image: repeating-linear-gradient(
    135deg,
    rgba(255,255,255,0.12) 0px,
    rgba(255,255,255,0.12) 6px,
    transparent 6px,
    transparent 12px
  );
  box-shadow: 0 0 0 1.5px rgba(255,255,255,0.7) inset, 0 1px 3px rgba(0,0,0,0.18);
}
.pb-pending-tag {
  display: inline-block;
  margin-left: 5px;
  font-family: 'Inter', sans-serif;
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
  background: rgba(0,0,0,0.28);
  padding: 1px 4px;
  border-radius: 4px;
  vertical-align: middle;
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
  border-top: 2px solid var(--pitch-mid);
}
.pb-now-dot {
  position: absolute;
  left: -5px;
  top: -5px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--pitch-mid);
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

.pb-repeat-hint {
  font-size: 12px;
  color: #6B5B5B;
  margin: -4px 0 0;
  line-height: 1.4;
}

.pb-series-summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 14px;
}
.pb-series-summary p { margin: 0; }
.pb-skip-list {
  margin: 6px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

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
.pb-detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.pb-detail-actions .pb-btn-danger { margin-top: 0; flex: 1; }
.pb-detail-edit { flex: 1; justify-content: center; }
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

.pb-status-tag {
  display: inline-block;
  width: fit-content;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
}
.pb-status-tag.approved { background: #E4F2E9; color: #1B4332; }
.pb-status-tag.pending { background: #FBEFD9; color: #8A5A00; }

.pb-approvals-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 60vh;
  overflow-y: auto;
}
.pb-approval-card {
  border: 1px solid var(--pitch-line);
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pb-approval-when {
  font-family: 'Oswald', sans-serif;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--pitch-mid);
}
.pb-approval-team { font-size: 14px; font-weight: 600; }
.pb-approval-type { font-size: 11.5px; color: #8A5A00; text-transform: uppercase; letter-spacing: 0.3px; font-weight: 600; }
.pb-approval-coach { font-size: 12.5px; color: #6B5B5B; }
.pb-approval-notes { font-size: 12px; color: #7C6B6B; font-style: italic; }
.pb-approval-actions { display: flex; gap: 8px; margin-top: 2px; }
.pb-approval-approve, .pb-approval-reject { flex: 1; }

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

.pb-tab-row {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.pb-coach-row { display: flex; gap: 8px; align-items: center; }
.pb-coach-row input {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--pitch-line);
  font-size: 14px;
  min-width: 0;
}
.pb-add-coach-row { display: flex; gap: 8px; margin-bottom: 14px; }
.pb-add-coach-row input {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--pitch-line);
  font-size: 14px;
  min-width: 0;
}

.pb-result-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
}
.pb-result-card {
  max-width: 420px;
  width: 100%;
  background: var(--card-bg);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 6px 24px rgba(0,0,0,0.12);
}
.pb-result-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  color: #fff;
}
.pb-result-head .pb-crest-img { width: 30px; height: 30px; }
.pb-result-head strong {
  font-family: 'Oswald', sans-serif;
  font-size: 15px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.pb-result-body { padding: 24px 22px; }
.pb-result-body h1 {
  font-family: 'Oswald', sans-serif;
  font-size: 20px;
  margin: 0 0 12px;
}
.pb-result-body p { font-size: 14.5px; line-height: 1.5; color: var(--charcoal); }
.pb-result-link {
  display: inline-block;
  text-decoration: none;
  margin-top: 12px;
  text-align: center;
}
`;
