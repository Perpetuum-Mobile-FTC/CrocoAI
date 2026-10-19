// Runs every 60s (plus the daily retention job, services/retention.js): sends due task reminders (tasks.remind_at, docs/design-meniu-v2.md §2) and legacy
// phone-only reminders, event reminders (24h/1h before), task-due-today
// notices (at 09:00), and assignment due-date reminders (24h before + overdue summary). Design v2 §9
// fixes: no overlapping ticks, `sent=1` only on success (with attempts/failed), correct azi/mâine
// wording, events created <1h before start get a single message, announcements go to TEAM_GROUP_ID
// only (no mass DMs).
const db = require("../db");
const { sendWhatsApp } = require("./wa-gateway");
const notifications = require("./notifications");
const { whatsappPhone } = require("./members");
const attendance = require("./attendance");
const { bucharestToUtcMs, utcToBucharest, addDays } = require("../domain/time");

const MAX_ATTEMPTS = 5;
const TASKS_LINK = "/teme?tab=taskuri";
let running = false;
let lastTickAt = null;

function getLastTickAt() { return lastTickAt; }

function notify(memberId, title, body, link) {
  notifications.create(memberId, "reminder", title, body || null, link || null);
}

// Legacy `reminders` rows not migrated to tasks (migration 018: phone-only targets). A target that is a member
// gets WhatsApp only on a verified phone (A3), otherwise in-app only; a placeholder `pending-*` number never.
async function sendReminder(r) {
  const member = r.target_member_id ? db.prepare("SELECT phone, phone_verified_at FROM members WHERE id = ?").get(r.target_member_id) : null;
  const phone = member ? whatsappPhone(member) : (/^\d{8,15}$/.test(String(r.target_phone || "")) ? r.target_phone : null);
  if (!phone && !r.target_member_id) {
    db.prepare("UPDATE reminders SET failed = 1 WHERE id = ?").run(r.id); // nowhere to deliver it
    return;
  }
  const ok = phone ? await sendWhatsApp(phone, `Reminder: ${r.message}`) : true;
  if (ok) {
    db.prepare("UPDATE reminders SET sent = 1 WHERE id = ?").run(r.id);
    if (r.target_member_id) notify(r.target_member_id, "Reminder", r.message, TASKS_LINK);
  } else {
    const attempts = (r.attempts || 0) + 1;
    db.prepare("UPDATE reminders SET attempts = ?, failed = ? WHERE id = ?").run(attempts, attempts >= MAX_ATTEMPTS ? 1 : 0, r.id);
  }
}

// A task's reminder: WhatsApp + in-app to the assignee, once. No verified phone (pending-*, unverified - A3) ->
// in-app only. Gateway failure -> retried next tick, failed after MAX_ATTEMPTS (like reminders).
async function sendTaskReminder(t) {
  const m = t.assigned_member_id ? db.prepare("SELECT phone, phone_verified_at FROM members WHERE id = ?").get(t.assigned_member_id) : null;
  const phone = whatsappPhone(m);
  const ok = phone ? await sendWhatsApp(phone, `Reminder: ${t.title}`) : true;
  if (ok) {
    db.prepare("UPDATE tasks SET reminded = 1 WHERE id = ?").run(t.id);
    if (t.assigned_member_id) notify(t.assigned_member_id, "Reminder", t.title, TASKS_LINK);
  } else {
    const attempts = (t.remind_attempts || 0) + 1;
    db.prepare("UPDATE tasks SET remind_attempts = ?, remind_failed = ? WHERE id = ?").run(attempts, attempts >= MAX_ATTEMPTS ? 1 : 0, t.id);
  }
}

// "azi" if the event is today (Bucharest-local calendar date), "mâine" if tomorrow, else "în curând".
function dayWord(startMs, nowMs) {
  const start = new Date(startMs);
  const now = new Date(nowMs);
  const startDay = start.toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" });
  const today = now.toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" });
  const tomorrow = new Date(nowMs + 24 * 3600 * 1000).toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" });
  if (startDay === today) return "azi";
  if (startDay === tomorrow) return "mâine";
  return "în curând";
}

// Who gets the in-app reminder: for a session that is a meeting or has an audience (department/group),
// the invited (attendance.invitedMemberIds - whole team without mentors/alumni); otherwise every active member.
function reminderRecipients(session) {
  const isMeeting = session && (session.team_id || session.target_dept || db.prepare("SELECT 1 FROM meetings WHERE session_id = ?").get(session.id));
  return isMeeting ? attendance.invitedMemberIds(session) : db.prepare("SELECT id FROM members WHERE status = 'activ'").all().map((m) => m.id);
}

async function broadcastEventReminder(title, startMs, when, session) {
  const text = `Eveniment "${title}" ${when} (${new Date(startMs).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" })}).`;
  if (process.env.TEAM_GROUP_ID) await sendWhatsApp(process.env.TEAM_GROUP_ID, text);
  for (const id of reminderRecipients(session)) notify(id, "Eveniment " + when, title, "/calendar");
}

// 24 h and 1 h before start. If created with <1 h to go, only the 1 h message fires (both flags get set
// together so no duplicate/contradictory message is sent). Returns the flags to set, or null.
async function remindIfDue({ title, startMs, flags, session }, nowMs) {
  const diffMs = startMs - nowMs;
  if (!(diffMs > 0)) return null;
  const word = dayWord(startMs, nowMs);
  if (diffMs <= 3600 * 1000) {
    if (flags.reminded_1h) return null;
    await broadcastEventReminder(title, startMs, word === "azi" ? "în curând" : word, session);
    return "both";
  }
  if (diffMs <= 24 * 3600 * 1000 && !flags.reminded_24h) {
    await broadcastEventReminder(title, startMs, word, session);
    return "24h";
  }
  return null;
}

async function tick(now = new Date()) {
  if (running) return; // no overlapping ticks
  running = true;
  try {

    const remindTasks = db.prepare("SELECT * FROM tasks WHERE remind_at IS NOT NULL AND reminded = 0 AND remind_failed = 0 AND status = 'pending'").all();
    for (const t of remindTasks) {
      if (Date.parse(t.remind_at) > now.getTime()) continue;
      await sendTaskReminder(t);
    }

    const pendingReminders = db.prepare("SELECT * FROM reminders WHERE sent = 0 AND (failed IS NULL OR failed = 0) AND migrated_task_id IS NULL").all();
    for (const r of pendingReminders) {
      if (new Date(r.remind_at).getTime() > now.getTime()) continue;
      await sendReminder(r);
    }

    // One-off events: reminder flags on the event.
    const events = db.prepare("SELECT * FROM events WHERE recurrence IS NULL AND (reminded_24h = 0 OR reminded_1h = 0)").all();
    for (const ev of events) {
      const session = db.prepare("SELECT * FROM attendance_sessions WHERE event_id = ? LIMIT 1").get(ev.id);
      const set = await remindIfDue({ title: ev.title, startMs: new Date(ev.start_time).getTime(), flags: ev, session }, now.getTime());
      if (set === "both") db.prepare("UPDATE events SET reminded_24h = 1, reminded_1h = 1 WHERE id = ?").run(ev.id);
      if (set === "24h") db.prepare("UPDATE events SET reminded_24h = 1 WHERE id = ?").run(ev.id);
    }

    // Weekly series: each occurrence (session, local date + HH:MM, DST-aware) has its own flags.
    const occurrences = db.prepare(`
      SELECT s.*, e.title AS event_title FROM attendance_sessions s JOIN events e ON e.id = s.event_id
      WHERE e.recurrence IS NOT NULL AND s.date >= ? AND (s.reminded_24h = 0 OR s.reminded_1h = 0)
    `).all(addDays(utcToBucharest(now.getTime()).date, -1));
    for (const s of occurrences) {
      const hhmm = (s.start_time || "").slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(hhmm)) continue;
      const set = await remindIfDue({ title: s.event_title, startMs: bucharestToUtcMs(s.date, hhmm), flags: s, session: s }, now.getTime());
      if (set === "both") db.prepare("UPDATE attendance_sessions SET reminded_24h = 1, reminded_1h = 1 WHERE id = ?").run(s.id);
      if (set === "24h") db.prepare("UPDATE attendance_sessions SET reminded_24h = 1 WHERE id = ?").run(s.id);
    }

    // Tasks due today, once per day at/after 09:00 Europe/Bucharest (not the server's TZ).
    const local = utcToBucharest(now.getTime());
    if (local.time >= "09:00") {
      const todayStr = local.date; // YYYY-MM-DD
      const dueTasks = db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND due_date = ? AND reminded_due = 0").all(todayStr);
      for (const t of dueTasks) {
        if (t.assigned_member_id) {
          const phone = whatsappPhone(db.prepare("SELECT phone, phone_verified_at FROM members WHERE id = ?").get(t.assigned_member_id));
          if (phone) await sendWhatsApp(phone, `Taskul "${t.title}" e scadent azi.`);
          notify(t.assigned_member_id, "Task scadent azi", t.title, TASKS_LINK);
        }
        db.prepare("UPDATE tasks SET reminded_due = 1 WHERE id = ?").run(t.id);
      }
    }

    // Expired pending registrations / old code sends (security package A3).
    try { require("./registration").cleanup(now); }
    catch (err) { console.error("[REMINDERS] registration cleanup:", err.message); }

    // Teme: 24h reminders + overdue summary (design-teme-grupuri.md §3).
    try { require("./assignment-notify").runDue(now); }
    catch (err) { console.error("[REMINDERS] assignments:", err.message); }

    // GDPR retention (cleanup F1, rules.RETENTION): once a day from 03:00 Bucharest.
    try { require("./retention").runDaily(now); }
    catch (err) { console.error("[REMINDERS] retention:", err.message); }

    // Daily AI cost alert to the active TL (ops package E).
    try { await require("./ai-usage").checkDailyCost(now); }
    catch (err) { console.error("[REMINDERS] ai cost:", err.message); }

    lastTickAt = new Date();
  } finally {
    running = false;
  }
}

function start() {
  setInterval(() => { tick().catch((err) => console.error("[REMINDERS]", err.message)); }, 60000);
  tick().catch((err) => console.error("[REMINDERS]", err.message));
}

module.exports = { start, tick, getLastTickAt };
