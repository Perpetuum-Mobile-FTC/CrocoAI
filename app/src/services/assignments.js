// Teme (design-teme-grupuri.md §1, §3). Routes and AI tools are thin wrappers over this module.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const files = require("./assignment-files");
const notify = require("./assignment-notify");
const { DEPT_LABEL, DEPARTMENTS } = require("../domain/audience");
const { teamInfo, assignmentDept } = require("./audience");
const MANAGE_MSG = "Doar cine a dat tema, un Team Leader sau șeful departamentului poate face asta.";

function requireAssignment(id) {
  const a = db.prepare("SELECT * FROM assignments WHERE id = ?").get(id);
  if (!a) throw new DomainError("NOT_FOUND", "Temă negăsită.");
  return a;
}

function isGroupMember(memberId, teamId) {
  return !!teamId && !!db.prepare("SELECT 1 FROM team_members WHERE team_id = ? AND member_id = ?").get(teamId, memberId);
}

function memberName(id) {
  if (!id) return null;
  const m = db.prepare("SELECT full_name FROM members WHERE id = ?").get(id);
  return m ? m.full_name : null;
}

function parseDue(value) {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(value);
  if (isNaN(d)) throw new DomainError("INVALID", "Termen invalid.");
  return d.toISOString();
}

// Multipart forms send the to-do list as a JSON string; JSON bodies send an array.
function parseTodos(value) {
  let list = value;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = []; } }
  return (Array.isArray(list) ? list : []).map((t) => String(t || "").trim()).filter(Boolean);
}

// Recipients of an individual assignment (design §1.4). Department-wide: only members/volunteers
// (leaders, heads and mentors have department 'ambele' but give assignments, they don't get them).
// Members with a pending requested_role (leadership/mentor) are excluded too.
// Group: everyone in the group. Creator excluded.
function recipientIds(a) {
  if (a.target_type === "departament") {
    return db.prepare(`
      SELECT id FROM members WHERE status = 'activ' AND COALESCE(role, 'member') IN ('member', 'volunteer')
        AND requested_role IS NULL AND (department = ? OR department = 'ambele') AND id <> ?
    `).all(a.target_dept, a.created_by).map((r) => r.id);
  }
  return db.prepare(`
    SELECT m.id FROM team_members tm JOIN members m ON m.id = tm.member_id
    WHERE tm.team_id = ? AND m.status = 'activ' AND m.id <> ?
  `).all(a.target_team_id, a.created_by).map((r) => r.id);
}

// Creates the missing submissions (+ their to-do rows). Returns member ids that got a new one.
function createSubmissions(a) {
  const todoIds = db.prepare("SELECT id FROM assignment_todos WHERE assignment_id = ?").all(a.id).map((r) => r.id);
  const insertSub = db.prepare("INSERT OR IGNORE INTO submissions (assignment_id, member_id) VALUES (?, ?)");
  const insertTodo = db.prepare("INSERT INTO submission_todos (submission_id, todo_id) VALUES (?, ?)");
  const addOne = (memberId) => {
    const info = insertSub.run(a.id, memberId);
    if (info.changes === 0) return false;
    for (const t of todoIds) insertTodo.run(info.lastInsertRowid, t);
    return true;
  };
  if (a.mode === "grup") {
    // UNIQUE does not apply to NULL member_id, so guard explicitly.
    if (!db.prepare("SELECT 1 FROM submissions WHERE assignment_id = ?").get(a.id)) addOne(null);
    return [];
  }
  return recipientIds(a).filter(addOne);
}

function isRecipient(actor, a) {
  if (a.mode === "grup") return isGroupMember(actor.id, a.target_team_id);
  return !!db.prepare("SELECT 1 FROM submissions WHERE assignment_id = ? AND member_id = ?").get(a.id, actor.id);
}

// Policy target for assignments.manage / review: creator + resolved department.
function policyTarget(a) {
  return { created_by: a.created_by, dept: assignmentDept(a) };
}

function canManage(actor, a) {
  return can(actor, "assignments.manage", policyTarget(a));
}

function canOversee(actor, a) {
  return can(actor, "assignments.view_all") || can(actor, "assignments.view_dept", { dept: assignmentDept(a) });
}

function canView(actor, a) {
  return canOversee(actor, a) || canManage(actor, a) || isRecipient(actor, a);
}

function canSeeSubmission(actor, sub, a) {
  if (canOversee(actor, a) || canManage(actor, a)) return true;
  return can(actor, "submissions.view", { mode: a.mode, member_id: sub.member_id, is_group_member: a.mode === "grup" && isGroupMember(actor.id, a.target_team_id) });
}

function isLate(a, sub) {
  return !!(a.due_at && sub.submitted_at && sub.submitted_at > a.due_at);
}

function submissionDetail(sub, a) {
  const todos = db.prepare(`
    SELECT st.todo_id, t.text, st.done, st.done_at, st.assignee_member_id,
      dm.full_name AS done_by_name, am.full_name AS assignee_name
    FROM submission_todos st JOIN assignment_todos t ON t.id = st.todo_id
    LEFT JOIN members dm ON dm.id = st.done_by LEFT JOIN members am ON am.id = st.assignee_member_id
    WHERE st.submission_id = ? ORDER BY t.position
  `).all(sub.id).map((t) => ({ ...t, done: !!t.done }));
  const fileRows = db.prepare(`
    SELECT f.id, f.version, f.filename, f.size, f.created_at, m.full_name AS uploaded_by_name
    FROM submission_files f LEFT JOIN members m ON m.id = f.uploaded_by
    WHERE f.submission_id = ? ORDER BY f.version, f.id
  `).all(sub.id);
  return {
    id: sub.id, status: sub.status, member_id: sub.member_id, member_name: memberName(sub.member_id),
    current_version: sub.current_version, submitted_at: sub.submitted_at, submitted_by_name: memberName(sub.submitted_by),
    late: isLate(a, sub), review_comment: sub.review_comment, reviewed_at: sub.reviewed_at,
    reviewed_by_name: memberName(sub.reviewed_by), todos, files: fileRows,
  };
}

function progress(assignmentId) {
  const out = { total: 0, de_facut: 0, predat: 0, de_refacut: 0, acceptat: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM submissions WHERE assignment_id = ? GROUP BY status").all(assignmentId)) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

function mySubmission(actor, a) {
  if (a.mode === "grup") {
    return isGroupMember(actor.id, a.target_team_id) ? db.prepare("SELECT * FROM submissions WHERE assignment_id = ?").get(a.id) : null;
  }
  return db.prepare("SELECT * FROM submissions WHERE assignment_id = ? AND member_id = ?").get(a.id, actor.id) || null;
}

function summary(actor, a) {
  const out = {
    id: a.id, title: a.title, due_at: a.due_at, mode: a.mode, target_type: a.target_type,
    target_label: a.target_label, target_team_id: a.target_team_id, status: a.status,
    created_by: a.created_by, created_by_name: memberName(a.created_by), created_at: a.created_at,
    can_manage: canManage(actor, a),
    can_review: can(actor, "assignments.review", policyTarget(a)),
  };
  const mine = mySubmission(actor, a);
  if (mine) out.my_submission = { id: mine.id, status: mine.status, submitted_at: mine.submitted_at, late: isLate(a, mine) };
  if (out.can_manage || canOversee(actor, a)) out.progress = progress(a.id);
  return out;
}

function allowedTargets(actor) {
  const departments = DEPARTMENTS.filter((d) => can(actor, "assignments.create", { target_type: "departament", target_dept: d }));
  const groups = db.prepare("SELECT id FROM teams ORDER BY name COLLATE NOCASE").all()
    .map((r) => teamInfo(r.id))
    .filter((t) => can(actor, "assignments.create", { target_type: "grup", team: t }))
    .map((t) => ({ id: t.id, name: t.name, department: t.department }));
  return { departments, groups };
}

function get(actor, id) {
  const a = requireAssignment(id);
  if (!canView(actor, a)) throw new DomainError("FORBIDDEN", "Nu ai acces la această temă.");
  const out = {
    ...summary(actor, a),
    description: a.description,
    materials: db.prepare("SELECT id, filename, size, created_at FROM assignment_materials WHERE assignment_id = ? ORDER BY id").all(a.id),
    todos: db.prepare("SELECT id, text, position FROM assignment_todos WHERE assignment_id = ? ORDER BY position").all(a.id),
  };
  const mine = mySubmission(actor, a);
  if (mine) out.my_submission = submissionDetail(mine, a);
  if (out.progress) {
    out.submissions = db.prepare("SELECT * FROM submissions WHERE assignment_id = ? ORDER BY id").all(a.id).map((s) => submissionDetail(s, a));
  }
  return out;
}

function create(actor, data, materialFiles = []) {
  const { title, description, mode, target_type, target_dept, target_team_id } = data || {};
  if (!title || !String(title).trim()) throw new DomainError("INVALID", "Titlul e obligatoriu.");
  if (!["individual", "grup"].includes(mode)) throw new DomainError("INVALID", "Alege modul temei (individual sau de grup).");
  if (!["departament", "grup"].includes(target_type)) throw new DomainError("INVALID", "Alege cui dai tema.");
  if (mode === "grup" && target_type !== "grup") throw new DomainError("INVALID", "O temă de grup se dă unui grup, nu unui departament întreg.");
  const due_at = parseDue(data.due_at);
  let team = null;
  let label;
  if (target_type === "departament") {
    if (!DEPT_LABEL[target_dept]) throw new DomainError("INVALID", "Departament invalid.");
    label = DEPT_LABEL[target_dept];
  } else {
    team = teamInfo(Number(target_team_id));
    if (!team) throw new DomainError("NOT_FOUND", "Grup negăsit.");
    label = team.name;
  }
  assertCan(actor, "assignments.create", { target_type, target_dept, team }, "Nu poți da teme acestei destinații.");
  const todos = parseTodos(data.todos);
  materialFiles.forEach(files.check);

  const id = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO assignments (title, description, due_at, mode, target_type, target_dept, target_team_id, target_label, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(title).trim(), description || null, due_at, mode, target_type,
      target_type === "departament" ? target_dept : null, team ? team.id : null, label, actor.id);
    const insTodo = db.prepare("INSERT INTO assignment_todos (assignment_id, text, position) VALUES (?, ?, ?)");
    todos.forEach((text, i) => insTodo.run(info.lastInsertRowid, text, i));
    createSubmissions(requireAssignment(info.lastInsertRowid));
    return info.lastInsertRowid;
  })();

  try {
    const ins = db.prepare("INSERT INTO assignment_materials (assignment_id, filename, path, size, mime, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)");
    for (const f of materialFiles) {
      const s = files.save(`${id}/materials`, f);
      ins.run(id, s.filename, s.path, s.size, s.mime, actor.id);
    }
  } catch (err) {
    db.prepare("DELETE FROM assignments WHERE id = ?").run(id);
    files.removeAssignmentDir(id);
    throw err;
  }

  const a = requireAssignment(id);
  notify.newAssignment(a, notify.assignmentMemberIds(a).filter((m) => m !== actor.id));
  return get(actor, id);
}

function list(actor, { scope = "mine", status } = {}) {
  let rows;
  if (scope === "review") {
    // „De verificat”: the same rows (and counts) as the Acasă card.
    return reviewRows(actor).map((a) => ({ ...summary(actor, a), waiting: a.waiting }));
  }
  if (scope === "given") {
    rows = db.prepare("SELECT * FROM assignments WHERE created_by = ?").all(actor.id);
  } else if (scope === "all") {
    const global = can(actor, "assignments.view_all");
    if (!global && !can(actor, "assignments.view_dept")) throw new DomainError("FORBIDDEN", "Doar liderii, mentorii și șefii de departament văd temele astea.");
    rows = db.prepare("SELECT * FROM assignments").all();
    if (!global) rows = rows.filter((a) => can(actor, "assignments.view_dept", { dept: assignmentDept(a) }));
  } else if (scope === "mine") {
    rows = db.prepare(`
      SELECT a.* FROM assignments a WHERE
        (a.mode = 'individual' AND EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id = a.id AND s.member_id = @me))
        OR (a.mode = 'grup' AND a.target_team_id IN (SELECT team_id FROM team_members WHERE member_id = @me))
    `).all({ me: actor.id });
  } else {
    throw new DomainError("INVALID", "Filtru invalid.");
  }
  if (status) rows = rows.filter((a) => a.status === status);
  rows.sort((x, y) =>
    (x.status === y.status ? 0 : x.status === "activa" ? -1 : 1) ||
    (x.due_at || "9999").localeCompare(y.due_at || "9999") ||
    y.id - x.id);
  return rows.map((a) => summary(actor, a));
}

function update(actor, id, data = {}) {
  const a = requireAssignment(id);
  assertCan(actor, "assignments.manage", policyTarget(a), MANAGE_MSG);
  const title = data.title !== undefined ? String(data.title).trim() : a.title;
  if (!title) throw new DomainError("INVALID", "Titlul e obligatoriu.");
  const description = data.description !== undefined ? (data.description || null) : a.description;
  const due_at = data.due_at !== undefined ? parseDue(data.due_at) : a.due_at;
  const dueChanged = due_at !== a.due_at;
  db.prepare(`UPDATE assignments SET title = ?, description = ?, due_at = ?,
      reminded_due = CASE WHEN ? THEN 0 ELSE reminded_due END,
      summarized_due = CASE WHEN ? THEN 0 ELSE summarized_due END WHERE id = ?`)
    .run(title, description, due_at, dueChanged ? 1 : 0, dueChanged ? 1 : 0, a.id);
  return get(actor, a.id);
}

function close(actor, id) {
  const a = requireAssignment(id);
  assertCan(actor, "assignments.manage", policyTarget(a), MANAGE_MSG);
  db.prepare("UPDATE assignments SET status = 'inchisa' WHERE id = ?").run(a.id);
  return get(actor, a.id);
}

function remove(actor, id) {
  const a = requireAssignment(id);
  assertCan(actor, "assignments.manage", policyTarget(a), MANAGE_MSG);
  if (db.prepare("SELECT 1 FROM submissions WHERE assignment_id = ? AND status <> 'de_facut'").get(a.id)) {
    throw new DomainError("INVALID", "Tema are deja predări — o poți doar închide.");
  }
  db.prepare("DELETE FROM assignments WHERE id = ?").run(a.id);
  try { files.removeAssignmentDir(a.id); } catch (e) { console.error(`[ASSIGNMENTS] remove files of ${a.id}: ${e.message}`); }
}

function addNewMembers(actor, id) {
  const a = requireAssignment(id);
  assertCan(actor, "assignments.manage", policyTarget(a), MANAGE_MSG);
  if (a.mode !== "individual" || a.status !== "activa") throw new DomainError("INVALID", "Doar temele individuale active primesc membri noi.");
  const added = db.transaction(() => createSubmissions(a))();
  notify.newAssignment(a, added);
  return { added: added.length };
}

// System action (no actor): a newly registered member gets the open department-wide individual
// assignments. Reuses createSubmissions, so recipient rules apply and existing rows are skipped.
function addMemberToOpenAssignments(memberId) {
  const open = db.prepare("SELECT * FROM assignments WHERE status = 'activa' AND mode = 'individual' AND target_type = 'departament'").all();
  let count = 0;
  for (const a of open) {
    const added = db.transaction(() => createSubmissions(a))();
    if (added.length) notify.newAssignment(a, added);
    if (added.includes(memberId)) count += 1;
  }
  return count;
}

function materialFile(actor, assignmentId, fileId) {
  const a = requireAssignment(assignmentId);
  if (!canView(actor, a)) throw new DomainError("FORBIDDEN", "Nu ai acces la această temă.");
  const row = db.prepare("SELECT * FROM assignment_materials WHERE id = ? AND assignment_id = ?").get(fileId, a.id);
  if (!row) throw new DomainError("NOT_FOUND", "Fișier negăsit.");
  return { row, absPath: files.absPath(row.path) };
}

// „De verificat” (Acasă card + the Teme filter, design-pachet-b.md B1): assignments with handed-in work the actor may review.
function reviewRows(actor) {
  return db.prepare(`
    SELECT a.*, COUNT(s.id) AS waiting FROM assignments a JOIN submissions s ON s.assignment_id = a.id
    WHERE s.status = 'predat' GROUP BY a.id ORDER BY a.due_at IS NULL, a.due_at, a.id
  `).all().filter((a) => can(actor, "assignments.review", policyTarget(a)));
}
function toReview(actor) {
  return reviewRows(actor).map((a) => ({ id: a.id, title: a.title, waiting: a.waiting }));
}

module.exports = {
  allowedTargets, create, list, get, toReview, update, close, remove, addNewMembers, addMemberToOpenAssignments, materialFile,
  requireAssignment, policyTarget, isGroupMember, canSeeSubmission, submissionDetail,
};
