// Lucrul la teme (design-teme-grupuri.md §3): bife, fișiere pe versiuni, predare, verificare.
// Files uploaded after the last "Predau" belong to version current_version+1 (the draft).
// While submitted (not yet reviewed), extra files join the submitted version; "Anulez predarea" turns it back into a draft.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const files = require("./assignment-files");
const notify = require("./assignment-notify");
const { requireAssignment, policyTarget, isGroupMember, canSeeSubmission, submissionDetail } = require("./assignments");

function load(subId) {
  const sub = db.prepare("SELECT * FROM submissions WHERE id = ?").get(subId);
  if (!sub) throw new DomainError("NOT_FOUND", "Predare negăsită.");
  return { sub, a: requireAssignment(sub.assignment_id) };
}

function assertWork(actor, sub, a) {
  const target = { status: a.status, mode: a.mode, member_id: sub.member_id, is_group_member: isGroupMember(actor.id, a.target_team_id) };
  if (can(actor, "submissions.work", target)) return;
  throw new DomainError("FORBIDDEN", a.status !== "activa" ? "Tema e închisă." : "Nu lucrezi la această temă.");
}

function assertEditable(sub) {
  if (sub.status === "predat" || sub.status === "acceptat") {
    throw new DomainError("INVALID", "Lucrarea e predată — așteaptă verificarea.");
  }
}

function detail(subId) {
  const { sub, a } = load(subId);
  return submissionDetail(sub, a);
}

function toggleTodo(actor, subId, todoId, { done, assignee_member_id } = {}) {
  const { sub, a } = load(subId);
  assertWork(actor, sub, a);
  assertEditable(sub);
  const row = db.prepare("SELECT st.*, t.text FROM submission_todos st JOIN assignment_todos t ON t.id = st.todo_id WHERE st.submission_id = ? AND st.todo_id = ?").get(sub.id, todoId);
  if (!row) throw new DomainError("NOT_FOUND", "Punct din to-do negăsit.");
  if (assignee_member_id !== undefined) {
    if (a.mode !== "grup") throw new DomainError("INVALID", "Doar la temele de grup se împart punctele.");
    const assignee = assignee_member_id ? Number(assignee_member_id) : null;
    if (assignee && !isGroupMember(assignee, a.target_team_id)) throw new DomainError("INVALID", "Poți da punctul doar unui membru al grupului.");
    db.prepare("UPDATE submission_todos SET assignee_member_id = ? WHERE submission_id = ? AND todo_id = ?").run(assignee, sub.id, row.todo_id);
    if (assignee && assignee !== row.assignee_member_id && assignee !== actor.id) notify.todoAssigned(a, row.text, assignee);
  }
  if (done !== undefined) {
    db.prepare(`UPDATE submission_todos SET done = ?, done_by = ?, done_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END
      WHERE submission_id = ? AND todo_id = ?`).run(done ? 1 : 0, done ? actor.id : null, done ? 1 : 0, sub.id, row.todo_id);
  }
  return detail(sub.id);
}

function addFiles(actor, subId, list) {
  const { sub, a } = load(subId);
  assertWork(actor, sub, a);
  if (sub.status === "acceptat") throw new DomainError("INVALID", "Lucrarea e deja acceptată.");
  if (!list || !list.length) throw new DomainError("INVALID", "Niciun fișier primit.");
  list.forEach(files.check);
  const version = sub.status === "predat" ? sub.current_version : sub.current_version + 1;
  const ins = db.prepare("INSERT INTO submission_files (submission_id, version, filename, path, size, mime, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const f of list) {
    const s = files.save(`${a.id}/submissions/${sub.id}`, f);
    ins.run(sub.id, version, s.filename, s.path, s.size, s.mime, actor.id);
  }
  return detail(sub.id);
}

function removeFile(actor, subId, fileId) {
  const { sub, a } = load(subId);
  assertWork(actor, sub, a);
  const f = db.prepare("SELECT * FROM submission_files WHERE id = ? AND submission_id = ?").get(fileId, sub.id);
  if (!f) throw new DomainError("NOT_FOUND", "Fișier negăsit.");
  if (f.version <= sub.current_version) throw new DomainError("INVALID", "Fișierele predate nu se mai pot șterge.");
  db.prepare("DELETE FROM submission_files WHERE id = ?").run(f.id);
  files.remove(f.path);
  return detail(sub.id);
}

function submit(actor, subId) {
  const { sub, a } = load(subId);
  assertWork(actor, sub, a);
  if (sub.status === "predat" || sub.status === "acceptat") throw new DomainError("INVALID", "Lucrarea e deja predată.");
  const draftFiles = db.prepare("SELECT COUNT(*) c FROM submission_files WHERE submission_id = ? AND version = ?").get(sub.id, sub.current_version + 1).c;
  const t = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(done), 0) done FROM submission_todos WHERE submission_id = ?").get(sub.id);
  if (draftFiles === 0 && !(t.total > 0 && t.done === t.total)) {
    throw new DomainError("INVALID", "Încarcă cel puțin un fișier sau bifează tot to-do-ul înainte să predai.");
  }
  db.prepare(`UPDATE submissions SET status = 'predat', current_version = current_version + 1, submitted_by = ?,
    submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(actor.id, sub.id);
  return detail(sub.id);
}

// Undo "Predau" before review: the submitted version becomes the draft again (files editable).
function unsubmit(actor, subId) {
  const { sub, a } = load(subId);
  assertWork(actor, sub, a);
  if (sub.status !== "predat") throw new DomainError("INVALID", "Poți anula doar o predare încă neverificată.");
  db.prepare(`UPDATE submissions SET status = ?, current_version = current_version - 1, submitted_by = NULL, submitted_at = NULL
    WHERE id = ?`).run(sub.reviewed_at ? "de_refacut" : "de_facut", sub.id);
  return detail(sub.id);
}

function review(actor, subId, { decision, comment } = {}) {
  const { sub, a } = load(subId);
  assertCan(actor, "assignments.review", policyTarget(a), "Doar cine a dat tema, un Team Leader sau șeful departamentului poate verifica.");
  if (sub.status !== "predat") throw new DomainError("INVALID", "Se pot verifica doar lucrările predate.");
  if (!["acceptat", "de_refacut"].includes(decision)) throw new DomainError("INVALID", "Decizie invalidă.");
  const text = String(comment || "").trim();
  if (decision === "de_refacut" && !text) throw new DomainError("INVALID", "Scrie ce trebuie refăcut.");
  db.prepare(`UPDATE submissions SET status = ?, review_comment = ?, reviewed_by = ?,
    reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(decision, text || null, actor.id, sub.id);
  const updated = db.prepare("SELECT * FROM submissions WHERE id = ?").get(sub.id);
  notify.reviewed(a, updated, notify.submissionMemberIds(a, updated));
  return submissionDetail(updated, a);
}

function submissionFile(actor, subId, fileId) {
  const { sub, a } = load(subId);
  if (!canSeeSubmission(actor, sub, a)) throw new DomainError("FORBIDDEN", "Nu ai acces la această lucrare.");
  const row = db.prepare("SELECT * FROM submission_files WHERE id = ? AND submission_id = ?").get(fileId, sub.id);
  if (!row) throw new DomainError("NOT_FOUND", "Fișier negăsit.");
  return { row, absPath: files.absPath(row.path) };
}

// To-do points assigned to me in active group assignments, not yet done (shown on Taskuri).
function myTodos(actor) {
  return db.prepare(`
    SELECT st.submission_id, st.todo_id, t.text, a.id AS assignment_id, a.title AS assignment_title, a.due_at
    FROM submission_todos st
    JOIN assignment_todos t ON t.id = st.todo_id
    JOIN submissions s ON s.id = st.submission_id
    JOIN assignments a ON a.id = s.assignment_id
    WHERE st.assignee_member_id = ? AND st.done = 0 AND a.status = 'activa'
      AND s.status IN ('de_facut', 'de_refacut')
      AND (a.mode = 'individual' OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = a.target_team_id AND tm.member_id = st.assignee_member_id))
    ORDER BY a.due_at IS NULL, a.due_at, a.id
  `).all(actor.id);
}

module.exports = { toggleTodo, addFiles, removeFile, submit, unsubmit, review, submissionFile, myTodos };
