// Scheduling, changing and cancelling meetings (design-sedinte-v2.md §1, design-sedinte-v3.md §1): event +
// attendance session + meeting row, Meet link, one announcement per change.
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const { bucharestToUtcMs } = require("../domain/time"); // DST-aware local -> UTC
const attendanceSvc = require("./attendance");
const googleMeetSvc = require("./google-meet");
const eventsSvc = require("./events");
const notificationsSvc = require("./notifications");
const waGateway = require("./wa-gateway");
const audience = require("./meeting-audience");
const {
  MEETING_SESSION_TYPES, AUDIO_DIR, requireSession, requireMeetingRow, parseMeeting, assertNotApproved, targetOf, assertOrganize,
  get, normalizeMeetLink, googleTimes, dropGoogleEvent,
} = require("./meeting-core");

const WEEKDAYS = ["duminică", "luni", "marți", "miercuri", "joi", "vineri", "sâmbătă"];

function dayLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}

function validateSchedule(d) {
  const bad = (msg) => { throw new DomainError("INVALID", msg); };
  if (!d.title || !String(d.title).trim()) bad("Titlul este obligatoriu.");
  if (!MEETING_SESSION_TYPES.includes(d.type)) bad("Tipul trebuie să fie sedinta sau urgenta.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || "") || isNaN(new Date(d.date + "T00:00:00Z"))) bad("Data invalidă (AAAA-LL-ZZ).");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time || "")) bad("Ora invalidă (HH:MM).");
  if (!Number.isInteger(d.duration) || d.duration < 15 || d.duration > 600) bad("Durata trebuie să fie între 15 și 600 minute.");
  if (!["fizic", "online"].includes(d.mode)) bad("Locul trebuie să fie fizic sau online.");
  if (d.mode === "fizic" && !(d.location && String(d.location).trim())) bad("Sala este obligatorie pentru o ședință fizică.");
  if (!Array.isArray(d.agenda) || d.agenda.some((a) => typeof a !== "string")) bad("Agenda trebuie să fie o listă de puncte text.");
}

function assertSlotFree(d, exceptSessionId, teamId, dept) {
  const clash = db.prepare("SELECT id FROM attendance_sessions WHERE date = ? AND IFNULL(start_time,'') = ? AND type = ? AND IFNULL(team_id,0) = ? AND IFNULL(target_dept,'') = ? AND id != ?")
    .get(d.date, d.time, d.type, teamId || 0, dept || "", exceptSessionId || 0);
  if (clash) throw new DomainError("INVALID", "Există deja o ședință identică (dată, oră, tip).");
}

// Online: manual link wins; otherwise a Google Meet is created automatically when configured.
async function resolveMeet(d) {
  if (d.meet_link && String(d.meet_link).trim()) return { link: normalizeMeetLink(d.meet_link), source: "manual", eventId: null };
  if (!googleMeetSvc.isConfigured()) throw new DomainError("INVALID", "Meet nu e configurat - introdu linkul manual.");
  const auto = await googleMeetSvc.createMeetingEvent({ title: d.title, ...googleTimes({ date: d.date, start_time: d.time }, d.duration) });
  if (!auto) throw new DomainError("INVALID", "Crearea automată a linkului Meet a eșuat - introdu linkul manual.");
  return { link: auto.link, source: "auto", eventId: auto.eventId };
}

function placeOf(d, link) { return d.mode === "online" ? link : String(d.location).trim(); }

// One group message (TEAM_GROUP_ID, if set; the audience named in the text) + an in-app notification
// for every invited member (design-sedinte-v3.md §1). No DMs.
async function announce(kind, { title, date, time, place, agenda, session, label }) {
  const what = label ? `${label} — ${title}, ${dayLabel(date)}, ora ${time}` : `${title} — ${dayLabel(date)}, ora ${time}`;
  let text;
  let inAppTitle;
  if (kind === "cancel") { text = `❌ Ședință anulată: ${what}.`; inAppTitle = "Ședință anulată"; }
  else {
    const agendaPart = agenda && agenda.length ? ` Ordinea de zi: ${agenda.join("; ")}.` : "";
    const head = kind === "update" ? "📅 Ședință modificată:" : "📅 Ședință";
    text = `${head} ${what}, ${place}.${agendaPart}`;
    inAppTitle = kind === "update" ? "Ședință modificată" : "Ședință nouă";
  }
  // Link: the Ședințe section for those who can see it, otherwise Acasă (their upcoming-meetings card).
  for (const id of attendanceSvc.invitedMemberIds(session)) {
    const member = db.prepare("SELECT * FROM members WHERE id = ?").get(id);
    notificationsSvc.create(id, "meeting", inAppTitle, text.replace(/^\S+\s/, ""), audience.sectionAccess(member) ? "/sedinte" : "/");
  }
  if (process.env.TEAM_GROUP_ID) await waGateway.sendWhatsApp(process.env.TEAM_GROUP_ID, text);
}

// An event shared with other sessions (weekly recurrence) must never be rewritten/deleted for ONE
// meeting: give this session its own standalone copy first. Returns the event id to work on (or null).
const detachSharedEvent = db.transaction((actor, session) => {
  if (!session.event_id) return null;
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(session.event_id);
  if (!ev) return null;
  const shared = ev.recurrence || db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE event_id = ?").get(ev.id).c > 1;
  if (!shared) return ev.id;
  if (ev.recurrence) db.prepare("INSERT OR IGNORE INTO event_exceptions (event_id, date) VALUES (?, ?)").run(ev.id, session.date);
  const copy = eventsSvc.insertEvent(actor.id, { title: ev.title, location: ev.location, start_time: ev.start_time, end_time: ev.end_time, type: ev.type });
  db.prepare("UPDATE attendance_sessions SET event_id = ? WHERE id = ?").run(copy.id, session.id);
  return copy.id;
});

async function schedule(actor, data) {
  const aud = audience.fromRequest(data || {});
  assertCan(actor, "meetings.schedule", aud, "Nu poți programa ședințe pentru acești destinatari.");
  const d = {
    title: data && data.title, type: (data && data.type) || "sedinta", date: data && data.date, time: data && data.time,
    duration: data && data.duration != null ? Number(data.duration) : 120, mode: (data && data.mode) || "fizic",
    location: data && data.location, meet_link: data && data.meet_link, agenda: (data && data.agenda) || [],
  };
  if (d.type === "urgenta") assertCan(actor, "events.manage_urgenta", null, "Doar Team Leader-ul, Co-Leader-ul sau mentorii activi pot crea ședințe de urgență (Art. 51.1).");
  d.title = d.title && String(d.title).trim();
  validateSchedule(d);
  assertSlotFree(d, null, aud.team_id, aud.target_dept);
  const meet = d.mode === "online" ? await resolveMeet(d) : null;

  const startMs = bucharestToUtcMs(d.date, d.time);
  let created;
  try { created = db.transaction(() => {
    const ev = eventsSvc.insertEvent(actor.id, {
      title: d.title, type: d.type, location: d.mode === "fizic" ? String(d.location).trim() : null,
      start_time: new Date(startMs).toISOString(), end_time: new Date(startMs + d.duration * 60000).toISOString(),
    });
    const s = attendanceSvc.insertSession(actor.id, { date: d.date, start_time: d.time, type: d.type, title: d.title, event_id: ev.id, team_id: aud.team_id, target_dept: aud.target_dept });
    const info = db.prepare("INSERT INTO meetings (session_id, created_by, agenda, meet_link, meet_source, meet_event_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.id, actor.id, JSON.stringify(d.agenda), meet ? meet.link : null, meet ? meet.source : null, meet ? meet.eventId : null);
    return { id: info.lastInsertRowid, session: s };
  })(); } catch (err) {
    if (meet && meet.source === "auto" && meet.eventId) await googleMeetSvc.deleteMeetingEvent(meet.eventId); // no orphan Google event
    throw err;
  }
  const { id, session } = created;

  await announce("new", { title: d.title, date: d.date, time: d.time, place: placeOf(d, meet && meet.link), agenda: d.agenda, session, label: aud.label });
  return get(actor, id);
}

async function reschedule(actor, id, data) {
  const row = requireMeetingRow(id);
  assertOrganize(actor, row);
  assertNotApproved(row);
  const old = parseMeeting(row);
  const session = old.session;
  const patch = data || {};
  const pick = (k, cur) => (patch[k] !== undefined ? patch[k] : cur);
  const d = {
    title: String(pick("title", session.title) || "").trim(), type: session.type, date: pick("date", session.date),
    time: pick("time", (session.start_time || "").slice(0, 5)), duration: patch.duration != null ? Number(patch.duration) : (old.duration_min || 120),
    mode: pick("mode", old.mode), location: pick("location", old.location), meet_link: patch.meet_link, agenda: pick("agenda", old.agenda),
  };
  validateSchedule(d);
  if (d.date !== session.date || d.time !== (session.start_time || "").slice(0, 5)) assertSlotFree(d, session.id, session.team_id, session.target_dept);

  let meet = null; // null = leave the Meet link as is
  if (d.mode === "fizic") meet = { link: null, source: null, eventId: null };
  else if (!row.meet_link || (patch.meet_link && String(patch.meet_link).trim() !== row.meet_link)) meet = await resolveMeet(d);
  const link = meet ? meet.link : row.meet_link;

  const timeChanged = d.date !== session.date || d.time !== (session.start_time || "").slice(0, 5);
  const placeChanged = d.mode !== old.mode || (d.mode === "fizic" ? String(d.location).trim() !== (old.location || "") : link !== row.meet_link);
  const startMs = bucharestToUtcMs(d.date, d.time);
  const evData = {
    title: d.title, location: d.mode === "fizic" ? String(d.location).trim() : null,
    start_time: new Date(startMs).toISOString(), end_time: new Date(startMs + d.duration * 60000).toISOString(),
  };

  try { db.transaction(() => {
    const eventId = detachSharedEvent(actor, session);
    if (eventId) eventsSvc.patchEvent(eventId, evData);
    else {
      const ev = eventsSvc.insertEvent(actor.id, { ...evData, type: session.type });
      db.prepare("UPDATE attendance_sessions SET event_id = ? WHERE id = ?").run(ev.id, session.id);
    }
    attendanceSvc.patchSession(session.id, { date: d.date, start_time: d.time, title: d.title });
    db.prepare("UPDATE meetings SET agenda=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(JSON.stringify(d.agenda), id);
    if (meet) {
      db.prepare("UPDATE meetings SET meet_link=?, meet_source=?, meet_event_id=? WHERE id=?").run(meet.link, meet.source, meet.eventId, id);
    }
  })(); } catch (err) {
    // The Google event made for this change would be left orphaned (best-effort cleanup).
    if (meet && meet.source === "auto" && meet.eventId && meet.eventId !== row.meet_event_id) await googleMeetSvc.deleteMeetingEvent(meet.eventId);
    if (/UNIQUE/.test(err.message)) throw new DomainError("INVALID", "Există deja o ședință identică (dată, oră, tip, echipă).");
    throw err;
  }

  // Keep the Google event of an automatic link in step (best-effort): dropped when the link goes away or is
  // replaced, moved/renamed when only the time, duration or title changed.
  if (meet) {
    if (meet.eventId !== row.meet_event_id) await dropGoogleEvent(row);
  } else if (row.meet_source === "auto" && row.meet_event_id &&
    (timeChanged || d.duration !== old.duration_min || d.title !== (session.title || ""))) {
    await googleMeetSvc.updateMeetingEvent({ eventId: row.meet_event_id, title: d.title, ...googleTimes({ date: d.date, start_time: d.time }, d.duration) });
  }

  if (timeChanged || placeChanged) {
    await announce("update", { title: d.title, date: d.date, time: d.time, place: placeOf(d, link), agenda: d.agenda, session, label: old.audience.type === "echipa" ? null : old.audience.label });
  }
  return get(actor, id);
}

async function cancel(actor, id) {
  const row = requireMeetingRow(id);
  assertOrganize(actor, row);
  const session = requireSession(row.session_id);
  const label = targetOf(row, session).label;
  const refuse = (msg) => { throw new DomainError("INVALID", msg); };
  if (row.status === "approved") refuse("PV aprobat nu poate fi anulat (Art. 49.2).");
  if (db.prepare("SELECT COUNT(*) c FROM attendance_records WHERE session_id = ?").get(session.id).c > 0) refuse("Ședința are deja prezențe marcate - nu mai poate fi anulată.");
  if (row.audio_path || row.audio_status !== "none") refuse("Ședința are audio încărcat - nu mai poate fi anulată.");
  if (db.prepare("SELECT COUNT(*) c FROM meeting_recordings WHERE meeting_id = ? AND status != 'abandoned'").get(id).c > 0) refuse("Ședința are o înregistrare - nu mai poate fi anulată.");

  const time = (session.start_time || "").slice(0, 5);
  db.transaction(() => {
    db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
    attendanceSvc.removeSession(session.id);
    if (session.event_id) {
      const ev = db.prepare("SELECT recurrence FROM events WHERE id = ?").get(session.event_id);
      if (ev && ev.recurrence) db.prepare("INSERT OR IGNORE INTO event_exceptions (event_id, date) VALUES (?, ?)").run(session.event_id, session.date);
    }
    // A shared (recurring) event stays: only this one session goes away.
    const eventId = session.event_id && !db.prepare("SELECT 1 FROM events WHERE id = ? AND recurrence IS NOT NULL").get(session.event_id)
      && db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE event_id = ?").get(session.event_id).c === 0 ? session.event_id : null;
    if (eventId) eventsSvc.deleteEvent(eventId);
  })();
  fs.rmSync(path.join(AUDIO_DIR, String(row.id)), { recursive: true, force: true });
  await dropGoogleEvent(row);
  await announce("cancel", { title: session.title || "Ședință", date: session.date, time, session, label });
  return { ok: true };
}

module.exports = { schedule, reschedule, cancel, detachSharedEvent };
