// Assignment notifications (design-teme-grupuri.md §6): in-app + individual WhatsApp DMs through
// the paced queue (shared LUCID number). Never to TEAM_GROUP_ID. "pending-*" / unverified phones are skipped (A3).
const db = require("../db");
const notifications = require("./notifications");
const waQueue = require("./wa-queue");
const { whatsappPhone } = require("./members");

const { baseUrl } = require("../domain/team");

function fmtDue(iso) {
  if (!iso) return "fără termen";
  return new Date(iso).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", dateStyle: "short", timeStyle: "short" });
}

function send(memberIds, title, body, link) {
  const ids = [...new Set(memberIds.map(Number).filter(Boolean))];
  if (!ids.length) return;
  const rows = db.prepare(`SELECT id, phone, phone_verified_at FROM members WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  for (const m of rows) {
    notifications.create(m.id, "assignment", title, body, link);
    const phone = whatsappPhone(m);
    if (phone) waQueue.enqueue(phone, `📚 ${title}: ${body}\n${baseUrl()}${link}`);
  }
}

// Active members who work on a submission (the owner, or the group's members).
function submissionMemberIds(a, sub) {
  if (a.mode === "grup") {
    return db.prepare(`SELECT m.id FROM team_members tm JOIN members m ON m.id = tm.member_id
      WHERE tm.team_id = ? AND m.status = 'activ'`).all(a.target_team_id).map((r) => r.id);
  }
  const m = db.prepare("SELECT id FROM members WHERE id = ? AND status = 'activ'").get(sub.member_id);
  return m ? [m.id] : [];
}

function assignmentMemberIds(a) {
  const subs = db.prepare("SELECT * FROM submissions WHERE assignment_id = ?").all(a.id);
  return [...new Set(subs.flatMap((s) => submissionMemberIds(a, s)))];
}

function newAssignment(a, memberIds) {
  send(memberIds, "Temă nouă", `${a.title} (termen: ${fmtDue(a.due_at)})`, `/teme/${a.id}`);
}

function todoAssigned(a, todoText, memberId) {
  send([memberId], "Ai primit un punct din temă", `${a.title}: ${todoText}`, `/teme/${a.id}`);
}

function reviewed(a, sub, memberIds) {
  const ok = sub.status === "acceptat";
  send(memberIds, ok ? "Temă acceptată" : "Temă de refăcut", ok ? a.title : `${a.title} — ${sub.review_comment}`, `/teme/${a.id}`);
}

// Called every scheduler tick (design §3 "Remindere"): <24h before due -> members who haven't
// submitted; after due -> one summary to the creator. Flags make both one-shot.
function runDue(now = new Date()) {
  const nowIso = now.toISOString();
  const in24h = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  const soon = db.prepare(`SELECT * FROM assignments WHERE status = 'activa' AND due_at IS NOT NULL
    AND reminded_due = 0 AND due_at > ? AND due_at <= ?`).all(nowIso, in24h);
  for (const a of soon) {
    try {
      // Flag first: a failing send must never be retried every tick.
      db.prepare("UPDATE assignments SET reminded_due = 1 WHERE id = ?").run(a.id);
      const open = db.prepare("SELECT * FROM submissions WHERE assignment_id = ? AND status IN ('de_facut', 'de_refacut')").all(a.id);
      send(open.flatMap((s) => submissionMemberIds(a, s)), "Termen în mai puțin de 24h", `${a.title} (termen: ${fmtDue(a.due_at)})`, `/teme/${a.id}`);
    } catch (e) { console.error(`[REMINDERS] assignment ${a.id}: ${e.message}`); }
  }
  const past = db.prepare(`SELECT * FROM assignments WHERE status = 'activa' AND due_at IS NOT NULL
    AND summarized_due = 0 AND due_at <= ?`).all(nowIso);
  for (const a of past) {
    try {
      db.prepare("UPDATE assignments SET summarized_due = 1, reminded_due = 1 WHERE id = ?").run(a.id);
      const c = db.prepare(`SELECT COUNT(*) total, SUM(status IN ('de_facut', 'de_refacut')) missing
        FROM submissions WHERE assignment_id = ?`).get(a.id);
      send([a.created_by], "Termen depășit", `${a.title}: ${c.missing || 0} din ${c.total} n-au predat.`, `/teme/${a.id}`);
    } catch (e) { console.error(`[REMINDERS] assignment ${a.id}: ${e.message}`); }
  }
}

module.exports = { fmtDue, send, submissionMemberIds, assignmentMemberIds, newAssignment, todoAssigned, reviewed, runDue };
