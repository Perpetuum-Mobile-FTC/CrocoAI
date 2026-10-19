// Daily data-retention job (cleanup F1, GDPR). Periods live in rules.RETENTION (with their articles); this only
// applies them. Every step is a plain "delete what is older than the cutoff", so running it twice changes nothing.
// Expired pending registrations / old code sends are already removed every tick by registration.cleanup().
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { RETENTION } = require("../domain/rules");
const documents = require("./documents");
const { utcToBucharest } = require("../domain/time");

const AUDIO_DIR = () => process.env.MEETINGS_AUDIO_DIR || path.join(__dirname, "..", "..", "data", "meetings");
const DAY_MS = 24 * 3600 * 1000;
const RUN_AT = "03:00"; // Europe/Bucharest, after the night backup window

const daysBefore = (now, days) => new Date(now.getTime() - days * DAY_MS).toISOString();
function monthsBefore(now, months) {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

// Approved PVs older than the period: delete the audio folder (final file + recording chunks), keep the transcript.
function purgeMeetingAudio(cutoff) {
  let n = 0;
  const rows = db.prepare("SELECT id, audio_path FROM meetings WHERE status = 'approved' AND approved_at IS NOT NULL AND approved_at < ?").all(cutoff);
  for (const r of rows) {
    const dir = path.join(AUDIO_DIR(), String(r.id));
    const hadFiles = fs.existsSync(dir);
    if (hadFiles) fs.rmSync(dir, { recursive: true, force: true });
    if (r.audio_path) db.prepare("UPDATE meetings SET audio_path = NULL WHERE id = ?").run(r.id);
    if (hadFiles || r.audio_path) n += 1;
  }
  return n;
}

// Always logs one [RETENTION] line (with `error=` on failure) and rethrows, so runDaily retries on the next tick.
function run(now = new Date()) {
  try {
    const counts = deleteExpired(now);
    console.log(`[RETENTION] ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    return counts;
  } catch (err) {
    console.log(`[RETENTION] error=${err.message}`);
    throw err;
  }
}

function deleteExpired(now) {
  const logCutoff = daysBefore(now, RETENTION.messageLogs.days);
  const chatCutoff = daysBefore(now, RETENTION.oldTeamChat.days);
  const del = (sql, ...params) => db.prepare(sql).run(...params).changes;
  const counts = db.transaction(() => ({
    rejected_applications: del("DELETE FROM applications WHERE status = 'respinsa' AND COALESCE(decided_at, created_at) < ?",
      monthsBefore(now, RETENTION.rejectedApplications.months)),
    messages: del("DELETE FROM messages WHERE created_at < ?", logCutoff),
    wa_message_log: del("DELETE FROM wa_message_log WHERE created_at < ?", logCutoff),
    web_chat_messages: del("DELETE FROM web_chat_messages WHERE created_at < ?", logCutoff),
    ai_flags: del("DELETE FROM ai_flags WHERE created_at < ?", logCutoff),
    meeting_audio: 0,
    chat_messages: del("DELETE FROM chat_messages WHERE created_at < ?", chatCutoff), // chat_reports cascade
    chat_conversations: del(`DELETE FROM chat_conversations WHERE type != 'announce' AND created_at < ?
      AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = chat_conversations.id)`, chatCutoff),
    audit_log: del("DELETE FROM audit_log WHERE created_at < ?", monthsBefore(now, RETENTION.auditLog.years * 12)),
  }))();
  const med = documents.destroyMedicalOfLeftMembers(); // Art. 41.8, members already 'iesit'
  counts.medical_destroyed = med.destroyed;
  counts.medical_orphans_removed = med.orphans_removed;
  counts.medical_file_failures = med.file_failures;
  counts.meeting_audio = purgeMeetingAudio(daysBefore(now, RETENTION.meetingAudio.daysAfterApproval));
  return counts;
}

// Called on every scheduler tick: runs once per Bucharest day, from RUN_AT. The day is marked done only after a
// successful run (a failure is retried on the next tick). In memory only - after a restart it runs again that day,
// which is harmless (idempotent).
let lastRunDay = null;
function runDaily(now = new Date()) {
  const local = utcToBucharest(now.getTime());
  if (local.time < RUN_AT || lastRunDay === local.date) return null;
  let counts;
  try { counts = run(now); } catch { return null; } // already logged by run()
  lastRunDay = local.date;
  return counts;
}
function _resetDaily() { lastRunDay = null; }

module.exports = { run, runDaily, _resetDaily };
