// Grupuri (design-teme-grupuri.md §1.1, §2): teams + team_members with a department. Heads manage
// only groups of their department with members of that department (or "ambele").
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");

const DEPARTMENTS = ["tehnic", "non-tehnic", "mixt"];
const DEPT_MSG = "Poți gestiona doar grupuri din departamentul tău, cu membri din departamentul tău.";
const EXISTING_MSG = "Grupul conține membri din alt departament — doar Team Leader, Co-Leader sau mentorii îl pot modifica.";

function requireGroup(id) {
  const t = db.prepare("SELECT * FROM teams WHERE id = ?").get(id);
  if (!t) throw new DomainError("NOT_FOUND", "Grup negăsit.");
  return t;
}

function membersOf(teamId) {
  return db.prepare(`
    SELECT m.id, m.full_name AS name, m.department, tm.role FROM team_members tm
    JOIN members m ON m.id = tm.member_id WHERE tm.team_id = ? ORDER BY m.full_name COLLATE NOCASE
  `).all(teamId);
}

function policyTarget(department, memberIds) {
  if (!memberIds.length) return { department, member_departments: [] };
  const rows = db.prepare(`SELECT id, department FROM members WHERE id IN (${memberIds.map(() => "?").join(",")})`).all(...memberIds);
  if (rows.length !== new Set(memberIds).size) throw new DomainError("NOT_FOUND", "Membru negăsit.");
  return { department, member_departments: rows.map((r) => r.department || "ambele") };
}

function view(actor, t) {
  return { ...t, members: membersOf(t.id), can_manage: can(actor, "groups.manage", { department: t.department }) };
}

function list(actor) {
  const rows = can(actor, "groups.view_all")
    ? db.prepare("SELECT * FROM teams ORDER BY name COLLATE NOCASE").all()
    : db.prepare(`SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id
        WHERE tm.member_id = ? ORDER BY t.name COLLATE NOCASE`).all(actor.id);
  return rows.map((t) => view(actor, t));
}

function get(actor, id) {
  const t = requireGroup(id);
  const out = view(actor, t);
  if (!can(actor, "groups.view_all") && !out.members.some((m) => m.id === actor.id)) {
    throw new DomainError("FORBIDDEN", "Nu ai acces la acest grup.");
  }
  return out;
}

function create(actor, { name, description, department } = {}) {
  if (!name || !String(name).trim()) throw new DomainError("INVALID", "Numele grupului e obligatoriu.");
  const dept = department || "mixt";
  if (!DEPARTMENTS.includes(dept)) throw new DomainError("INVALID", "Departament invalid.");
  assertCan(actor, "groups.manage", { department: dept }, DEPT_MSG);
  const info = db.prepare("INSERT INTO teams (name, description, department, created_by) VALUES (?, ?, ?, ?)")
    .run(String(name).trim(), description || null, dept, actor.id);
  return get(actor, info.lastInsertRowid);
}

function update(actor, id, { name, description, department } = {}) {
  const t = requireGroup(id);
  assertCan(actor, "groups.manage", { department: t.department }, DEPT_MSG);
  const dept = department || t.department;
  if (!DEPARTMENTS.includes(dept)) throw new DomainError("INVALID", "Departament invalid.");
  if (dept !== t.department) assertCan(actor, "groups.manage", policyTarget(dept, membersOf(t.id).map((m) => m.id)), DEPT_MSG);
  if (name !== undefined && !String(name).trim()) throw new DomainError("INVALID", "Numele grupului e obligatoriu.");
  db.prepare("UPDATE teams SET name = ?, description = ?, department = ? WHERE id = ?")
    .run(name !== undefined ? String(name).trim() : t.name, description !== undefined ? description : t.description, dept, t.id);
  return get(actor, t.id);
}

// Replaces the whole membership. members: [{ member_id, role: "leader"|"member" }]
function setMembers(actor, id, members) {
  const t = requireGroup(id);
  if (!Array.isArray(members)) throw new DomainError("INVALID", "Lista de membri e invalidă.");
  const ids = members.map((m) => Number(m.member_id));
  if (ids.some((x) => !x)) throw new DomainError("INVALID", "Lista de membri e invalidă.");
  // Distinguish "the group already has off-department members" from "the requested set has some".
  const existing = membersOf(t.id).map((m) => m.id);
  const existingOk = can(actor, "groups.manage", policyTarget(t.department, existing));
  assertCan(actor, "groups.manage", policyTarget(t.department, ids), existingOk ? DEPT_MSG : EXISTING_MSG);
  db.transaction(() => {
    db.prepare("DELETE FROM team_members WHERE team_id = ?").run(t.id);
    const ins = db.prepare("INSERT INTO team_members (team_id, member_id, role) VALUES (?, ?, ?)");
    for (const m of members) ins.run(t.id, Number(m.member_id), m.role === "leader" ? "leader" : "member");
  })();
  return get(actor, t.id);
}

function addMember(actor, id, memberId, role) {
  const rest = membersOf(requireGroup(id).id).filter((m) => m.id !== Number(memberId)).map((m) => ({ member_id: m.id, role: m.role }));
  return setMembers(actor, id, [...rest, { member_id: Number(memberId), role }]);
}

function removeMember(actor, id, memberId) {
  const rest = membersOf(requireGroup(id).id).filter((m) => m.id !== Number(memberId)).map((m) => ({ member_id: m.id, role: m.role }));
  return setMembers(actor, id, rest);
}

function remove(actor, id) {
  const t = requireGroup(id);
  assertCan(actor, "groups.manage", { department: t.department }, DEPT_MSG);
  db.prepare("DELETE FROM teams WHERE id = ?").run(t.id);
}

// Departments the actor may create a group in (the "+ Grup nou" button and its select; policy groups.manage).
function creatableDepartments(actor) {
  return DEPARTMENTS.filter((d) => can(actor, "groups.manage", { department: d }));
}

module.exports = { list, get, create, update, setMembers, addMember, removeMember, remove, creatableDepartments };
