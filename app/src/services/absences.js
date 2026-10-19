// Absence requests (design v2 §4, §5: Art. 21.1 / 22.1 deadlines, Art. 21.1 decision by MANAGERS).
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const { checkAbsenceNotice, absenceReasonError } = require("../domain/rules");
const { bucharestToUtcMs } = require("../domain/time");

function create(actor, data) {
  assertCan(actor, "absence.request");
  const { session_id, date, reason } = data || {};
  if (!date && !session_id) throw new DomainError("INVALID", "Data sau sesiunea sunt obligatorii.");
  const reasonErr = absenceReasonError(reason);
  if (reasonErr) throw new DomainError("INVALID", reasonErr, "Art. 21.1", { reason: reasonErr });

  let session = null;
  let resolvedDate = date;
  if (session_id) {
    session = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(session_id);
    if (!session) throw new DomainError("NOT_FOUND", "Sesiune negăsită.");
    resolvedDate = session.date;
  }

  let tardiva = 0;
  let ulterioara = 0;
  if (session) {
    // session.date / start_time are Europe/Bucharest wall-clock (independent of the server TZ).
    const hhmm = /^\d{2}:\d{2}/.test(session.start_time || "") ? session.start_time.slice(0, 5) : "00:00";
    const sessionStart = new Date(bucharestToUtcMs(session.date, hhmm));
    const check = checkAbsenceNotice({ now: new Date(), sessionStart, sessionType: session.type, competitionLevel: session.competition_level });
    if (check.expired) throw new DomainError("LATE", check.message, check.article);
    tardiva = check.status === "tardiva" ? 1 : 0;
    ulterioara = check.ulterioara ? 1 : 0; // Art. 21.1: after the meeting (<= 48h): normal request, flagged
  }

  const info = db.prepare(`
    INSERT INTO absence_requests (member_id, session_id, date, reason, tardiva, ulterioara) VALUES (?, ?, ?, ?, ?, ?)
  `).run(actor.id, session_id || null, resolvedDate, reason.trim(), tardiva, ulterioara);
  return db.prepare("SELECT * FROM absence_requests WHERE id = ?").get(info.lastInsertRowid);
}

function list(actor, { member_id, status } = {}) {
  if (member_id) assertCan(actor, "absences.view", { member_id });
  let sql = "SELECT ar.*, m.full_name AS member_name FROM absence_requests ar JOIN members m ON m.id = ar.member_id WHERE 1=1";
  const params = [];
  if (member_id) { sql += " AND ar.member_id = ?"; params.push(member_id); }
  else if (!can(actor, "absences.view")) { sql += " AND ar.member_id = ?"; params.push(actor.id); }
  if (status) { sql += " AND ar.status = ?"; params.push(status); }
  sql += " ORDER BY ar.created_at DESC";
  return db.prepare(sql).all(...params);
}

function decide(actor, id, status, note) {
  assertCan(actor, "absence.decide");
  const req = db.prepare("SELECT * FROM absence_requests WHERE id = ?").get(id);
  if (!req) throw new DomainError("NOT_FOUND", "Cerere negăsită.");
  if (!["aprobata", "respinsa"].includes(status)) throw new DomainError("INVALID", "Status invalid.");

  db.prepare("UPDATE absence_requests SET status = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(status, actor.id, id);

  if (status === "aprobata" && req.session_id) {
    db.prepare(`
      INSERT INTO attendance_records (session_id, member_id, status, note, marked_by, marked_at)
      VALUES (?, ?, 'motivat', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(session_id, member_id) DO UPDATE SET status='motivat', marked_by=excluded.marked_by, marked_at=excluded.marked_at
    `).run(req.session_id, req.member_id, note || null, actor.id);
  }

  db.prepare("INSERT INTO notifications (member_id, type, title, body, link) VALUES (?, 'absence_decided', ?, ?, '/#prezenta-mea')")
    .run(req.member_id, status === "aprobata" ? "Cerere de motivare aprobată" : "Cerere de motivare respinsă", note || null);

  return db.prepare("SELECT * FROM absence_requests WHERE id = ?").get(id);
}

module.exports = { create, list, decide };
