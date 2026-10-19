// Attendance sessions, records, stats and signals (design v2 §5, §6).
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const rules = require("../domain/rules");
const { DEPARTMENTS, HEAD_ROLE } = require("../domain/audience");
const { sessionDept } = require("./audience");

const VALID_STATUSES = ["prezent", "absent", "motivat", "scutit"];
const VALID_TYPES = ["sedinta", "urgenta", "competitie", "antrenament", "eveniment"];

// ─── Audience (design-sedinte-v3.md §1) ───────────────────────────────────────────────────────
// THE invitee rule ("cei chemați"). A session is for a group (team_id), a department (target_dept)
// or the whole team (both NULL):
//   - department d: role member/volunteer with department d or 'ambele', plus the head of department d;
//   - group: every member of the group (any role);
//   - whole team: everyone except roles mentor and alumni.
// Default: ACTIVE members only (notified, marked A on close). `statuses` widens it for the roster
// (members on pause are listed) and for the "extra" flag (status doesn't make someone extra).
function invitedMemberIds(session, { statuses = ["activ"] } = {}) {
  let sql = `SELECT m.id FROM members m WHERE m.status IN (${statuses.map(() => "?").join(",")})`;
  const params = [...statuses];
  if (session.team_id) {
    sql += " AND m.id IN (SELECT member_id FROM team_members WHERE team_id = ?)";
    params.push(session.team_id);
  } else if (session.target_dept) {
    sql += " AND ((COALESCE(m.role, 'member') IN ('member', 'volunteer') AND (m.department = ? OR m.department = 'ambele')) OR m.role = ?)";
    params.push(session.target_dept, HEAD_ROLE[session.target_dept] || "");
  } else {
    sql += ` AND COALESCE(m.role, 'member') NOT IN (${rules.NO_ATTENDANCE_ROLES.map(() => "?").join(",")})`;
    params.push(...rules.NO_ATTENDANCE_ROLES);
  }
  return db.prepare(sql).all(...params).map((r) => r.id);
}

const NOT_LEFT = ["activ", "pauza", "alumni"];

// Roster shown for marking: the invitee rule over everyone who hasn't left (pause -> "scutit").
function rosterMembers(session) {
  const ids = invitedMemberIds(session, { statuses: NOT_LEFT });
  if (!ids.length) return [];
  return db.prepare(`SELECT id, full_name AS name, status FROM members WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY full_name COLLATE NOCASE`).all(...ids);
}

function isInvited(session, memberId) {
  return invitedMemberIds(session, { statuses: NOT_LEFT }).includes(Number(memberId));
}

// Unchecked insert - callers have already authorized (createSession: attendance.mark; meetings.schedule:
// the audience rule in policy.js).
function insertSession(createdBy, data) {
  const { date, start_time, type, title, team_id, target_dept, event_id, competition_level } = data || {};
  if (!date) throw new DomainError("INVALID", "Data este obligatorie.");
  if (target_dept && !DEPARTMENTS.includes(target_dept)) throw new DomainError("INVALID", "Departament invalid.");
  if (target_dept && team_id) throw new DomainError("INVALID", "Alege un singur destinatar (departament sau grup).");
  const finalType = VALID_TYPES.includes(type) ? type : "sedinta";
  const level = rules.resolveCompetitionLevel(finalType, competition_level);
  try {
    const info = db.prepare(`
      INSERT INTO attendance_sessions (date, start_time, title, type, team_id, target_dept, event_id, created_by, competition_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(date, start_time || "", title || null, finalType, team_id || null, target_dept || null, event_id || null, createdBy, level);
    return db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(info.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new DomainError("INVALID", "Există deja o sesiune identică (dată, oră, tip, destinatari).");
    throw err;
  }
}

// Art. 51.1: an emergency meeting is convened only by TL, Co-Leader or an active mentor.
function assertCanSession(actor, type) {
  if (type === "urgenta") assertCan(actor, "events.manage_urgenta", null, "Doar Team Leader-ul, Co-Leader-ul sau mentorii activi pot crea ședințe de urgență (Art. 51.1).");
  else assertCan(actor, "attendance.mark");
}

function createSession(actor, data) {
  assertCanSession(actor, data && data.type);
  return insertSession(actor.id, data);
}

function updateSession(actor, id, data) {
  const s = db.prepare("SELECT type FROM attendance_sessions WHERE id = ?").get(id);
  assertCanSession(actor, (data && data.type === "urgenta") || (s && s.type === "urgenta") ? "urgenta" : null);
  return patchSession(id, data);
}

// Unchecked update (see insertSession).
function patchSession(id, data) {
  const s = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(id);
  if (!s) throw new DomainError("NOT_FOUND", "Sesiune negăsită.");
  const { date, start_time, type, title, team_id, competition_level } = data || {};
  const finalType = (type && VALID_TYPES.includes(type)) ? type : s.type;
  const level = rules.resolveCompetitionLevel(finalType, competition_level, s.competition_level);
  db.prepare(`
    UPDATE attendance_sessions SET date=COALESCE(?,date), start_time=COALESCE(?,start_time),
      type=COALESCE(?,type), title=COALESCE(?,title), team_id=?, competition_level=?
    WHERE id = ?
  `).run(date || null, start_time !== undefined ? start_time : null, (type && VALID_TYPES.includes(type)) ? type : null,
    title !== undefined ? title : null, team_id !== undefined ? team_id : s.team_id, level, id);
  const updated = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(id);
  // New date/time: the per-occurrence 24h/1h reminders fire again (design-pachet-b.md B3).
  if (updated.date !== s.date || updated.start_time !== s.start_time) {
    db.prepare("UPDATE attendance_sessions SET reminded_24h = 0, reminded_1h = 0 WHERE id = ?").run(id);
  }
  return db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(id);
}

function deleteSession(actor, id) {
  assertCan(actor, "attendance.mark");
  removeSession(id);
}

function removeSession(id) {
  db.prepare("DELETE FROM attendance_sessions WHERE id = ?").run(id);
}

function listSessions(actor, { from, to, team_id } = {}) {
  let sql = "SELECT * FROM attendance_sessions WHERE 1=1";
  const params = [];
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  if (team_id) { sql += " AND team_id = ?"; params.push(team_id); }
  sql += " ORDER BY date, start_time";
  return db.prepare(sql).all(...params);
}

// Bulk upsert of records for one session: records = [{ member_id, status, note }]
function markRecords(actor, sessionId, records) {
  const session = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(sessionId);
  if (!session) throw new DomainError("NOT_FOUND", "Sesiune negăsită.");
  assertCan(actor, "attendance.mark", { dept: sessionDept(session) });
  upsertRecords(session, records, actor.id);
  return db.prepare("SELECT * FROM attendance_records WHERE session_id = ?").all(sessionId);
}

// Unchecked bulk upsert (callers authorize). `extra` = the member is outside the session's audience.
function upsertRecords(session, records, markedBy) {
  if (!Array.isArray(records)) throw new DomainError("INVALID", "records trebuie să fie listă.");
  for (const r of records) {
    if (!VALID_STATUSES.includes(r.status)) throw new DomainError("INVALID", `Status invalid: ${r.status}`);
  }
  const upsert = db.prepare(`
    INSERT INTO attendance_records (session_id, member_id, status, note, marked_by, marked_at, extra)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
    ON CONFLICT(session_id, member_id) DO UPDATE SET status=excluded.status, note=excluded.note, marked_by=excluded.marked_by,
      marked_at=excluded.marked_at, extra=excluded.extra
  `);
  db.transaction((recs) => {
    for (const r of recs) upsert.run(session.id, r.member_id, r.status, r.note || null, markedBy, isInvited(session, r.member_id) ? 0 : 1);
  })(records);
}

// Stats for one member in the current season (or a given from/to range), with signals.
function statsFor(actor, memberId, { from, to } = {}) {
  assertCan(actor, "attendance.view_stats", { member_id: memberId });
  const season = rules.seasonFor(new Date());
  const rangeFrom = from || season.from;
  const rangeTo = to || season.to;

  const rows = db.prepare(`
    SELECT s.id AS session_id, s.date, s.type, s.title, r.status, r.extra
    FROM attendance_records r
    JOIN attendance_sessions s ON s.id = r.session_id
    WHERE r.member_id = ? AND s.date BETWEEN ? AND ?
    ORDER BY s.date, s.start_time
  `).all(memberId, rangeFrom, rangeTo);

  // Extra participants (outside the session's audience) are never counted: a session counts only for
  // the invited (design-sedinte-v3.md §2), so extras can never lower anyone's percentage.
  const counting = rows.filter((r) => rules.COUNTING_SESSION_TYPES.includes(r.type) && !r.extra);
  const pct = rules.computeAttendancePct(counting.map((r) => r.status));

  const member = db.prepare("SELECT pause_until, status FROM members WHERE id = ?").get(memberId);
  let pauseWeeks = null;
  if (member && member.status === "pauza" && member.pause_until) {
    const history = db.prepare("SELECT * FROM member_status_history WHERE member_id = ? AND to_status = 'pauza' ORDER BY changed_at DESC LIMIT 1").get(memberId);
    if (history) pauseWeeks = Math.round((new Date().getTime() - new Date(history.changed_at).getTime()) / (7 * 24 * 3600 * 1000));
  }

  // Art. 20.2: no repeat warning for a member already warned in writing (or worse) this season.
  const warnedThisSeason = !!db.prepare(
    "SELECT 1 FROM warnings WHERE member_id = ? AND level IN ('scris','suspendare','excludere') AND created_at >= ? LIMIT 1"
  ).get(memberId, season.from);

  const signals = rules.computeSignals({
    warnedThisSeason,
    records: counting,
    pctAllTime: pct,
    sessionCount: counting.length,
    pauseWeeks,
    pauseReturnGapWeeks: null,
  });

  return {
    season: season.id,
    from: rangeFrom,
    to: rangeTo,
    sessions_counted: counting.length,
    present: counting.filter((r) => r.status === "prezent").length,
    absent: counting.filter((r) => r.status === "absent").length,
    motivat: counting.filter((r) => r.status === "motivat").length,
    scutit: counting.filter((r) => r.status === "scutit").length,
    extra_present: rows.filter((r) => r.extra && r.status === "prezent").length,
    pct,
    threshold_pct: season.thresholdPct,
    signals,
    // Last 5 marked sessions, newest first (Acasă „Prezența mea”, docs/design-meniu-v2.md).
    recent: rows.slice(-5).reverse().map((r) => ({ session_id: r.session_id, date: r.date, type: r.type, title: r.title, status: r.status })),
  };
}

function statsAll(actor, { from, to, team_id } = {}) {
  assertCan(actor, "attendance.view_all");
  let sql = "SELECT id, full_name AS name FROM members WHERE status != 'iesit'";
  const params = [];
  if (team_id) { sql = "SELECT m.id, m.full_name AS name FROM members m JOIN team_members tm ON tm.member_id = m.id WHERE tm.team_id = ? AND m.status != 'iesit'"; params.push(team_id); }
  const members = db.prepare(sql).all(...params);
  return members.map((m) => ({ member_id: m.id, member_name: m.name, ...statsFor(actor, m.id, { from, to }) }));
}

// Date x member grid, used for CSV/HTML exports and the marking UI.
function buildGrid(actor, { from, to, team_id } = {}) {
  assertCan(actor, "attendance.view_all");
  const season = rules.seasonFor(new Date());
  const rangeFrom = from || season.from;
  const rangeTo = to || season.to;

  const sessions = listSessions(actor, { from: rangeFrom, to: rangeTo, team_id });
  const sessionIds = sessions.map((s) => s.id);
  const records = sessionIds.length
    ? db.prepare(`SELECT * FROM attendance_records WHERE session_id IN (${sessionIds.map(() => "?").join(",")})`).all(...sessionIds)
    : [];
  const byKey = new Map(records.map((r) => [`${r.session_id}:${r.member_id}`, r.status]));

  const members = team_id
    ? db.prepare(`SELECT m.id, m.full_name AS name FROM team_members tm JOIN members m ON m.id = tm.member_id WHERE tm.team_id = ? AND m.status != 'iesit' ORDER BY m.full_name COLLATE NOCASE`).all(team_id)
    : db.prepare("SELECT id, full_name AS name FROM members WHERE status != 'iesit' ORDER BY full_name COLLATE NOCASE").all();

  const out = members.map((m) => {
    const bySession = {};
    for (const s of sessions) bySession[s.id] = byKey.get(`${s.id}:${m.id}`) || null;
    return { id: m.id, name: m.name, records: bySession };
  });

  return { sessions, members: out };
}

// Members with an approved absence request for this session or its date (Art. 21.1 -> "motivat").
function approvedAbsenceIds(session) {
  return new Set(db.prepare("SELECT member_id FROM absence_requests WHERE status = 'aprobata' AND (session_id = ? OR date = ?)")
    .all(session.id, session.date).map((r) => r.member_id));
}

// Unchecked roster view: the audience (team- or department-filtered), each entry carrying the
// member's status (so "scutit" can be offered for members on pause) and their record, if any;
// then the extra participants (records of members outside the audience) flagged `extra: true`.
function sessionRoster(session) {
  const records = db.prepare("SELECT * FROM attendance_records WHERE session_id = ?").all(session.id);
  const recordByMember = new Map(records.map((r) => [r.member_id, r]));
  const approved = approvedAbsenceIds(session); // pre-mark "motivat" (suggestion only until saved)

  const members = rosterMembers(session);
  const inRoster = new Set(members.map((m) => m.id));
  const roster = members.map((m) => {
    const rec = recordByMember.get(m.id);
    const entry = { id: m.id, name: m.name, status: m.status, record: rec ? rec.status : null };
    if (!rec && approved.has(m.id)) entry.suggested = "motivat";
    return entry;
  });
  const extras = records.filter((r) => !inRoster.has(r.member_id));
  if (extras.length) {
    const names = db.prepare(`SELECT id, full_name AS name, status FROM members WHERE id IN (${extras.map(() => "?").join(",")})`)
      .all(...extras.map((r) => r.member_id));
    const byId = new Map(names.map((m) => [m.id, m]));
    for (const r of extras) {
      const m = byId.get(r.member_id) || { name: "?", status: null };
      roster.push({ id: r.member_id, name: m.name, status: m.status, record: r.status, extra: true });
    }
  }
  return { records, roster };
}

// One session with its records + roster (see sessionRoster). OVERSIGHT read.
function getSessionDetail(actor, id) {
  assertCan(actor, "attendance.view_all");
  const session = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(id);
  if (!session) throw new DomainError("NOT_FOUND", "Sesiune negăsită.");
  return { session, ...sessionRoster(session) };
}

module.exports = {
  VALID_STATUSES, VALID_TYPES, DEPARTMENTS,
  createSession, updateSession, deleteSession, listSessions,
  markRecords, statsFor, statsAll, buildGrid, getSessionDetail,
  // unchecked internals for services that authorize themselves (meetings, design-sedinte-v3.md)
  insertSession, patchSession, removeSession, upsertRecords, sessionRoster,
  invitedMemberIds, isInvited, approvedAbsenceIds,
};
