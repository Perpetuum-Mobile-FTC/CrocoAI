// Meeting audience ("Pentru", design-sedinte-v3.md §1): whole team, a department or a group. Turns
// request data / a stored session into the policy target used by meetings.schedule / organize / view.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { can } = require("../domain/policy");
const { DEPT_LABEL, resolveDept } = require("../domain/audience");
const { teamInfo } = require("./audience");

// Request body -> { target_type, target_dept, team, team_id, label } (validated, not yet authorized).
function fromRequest(data) {
  const type = (data && data.target_type) || "echipa";
  if (type === "echipa") return { target_type: "echipa", target_dept: null, team: null, team_id: null, label: null };
  if (type === "departament") {
    if (!DEPT_LABEL[data.target_dept]) throw new DomainError("INVALID", "Departament invalid.");
    return { target_type: type, target_dept: data.target_dept, team: null, team_id: null, label: DEPT_LABEL[data.target_dept] };
  }
  if (type === "grup") {
    const team = teamInfo(Number(data.target_team_id));
    if (!team) throw new DomainError("INVALID", "Grup inexistent.");
    return { target_type: type, target_dept: null, team, team_id: team.id, label: `Grupul ${team.name}` };
  }
  throw new DomainError("INVALID", "Alege pentru cine e ședința.");
}

// Stored session (+ meeting creator) -> policy target. `dept` = THE department of the meeting:
// target_dept, or the group's department ("mixt" for mixed groups); null for whole-team meetings.
function ofSession(session, createdBy) {
  let a;
  if (session.team_id) {
    const team = teamInfo(session.team_id) || { id: session.team_id, name: "?", department: null, leader_ids: [] };
    a = { target_type: "grup", target_dept: null, team, team_id: team.id, label: `Grupul ${team.name}` };
  } else if (session.target_dept) {
    a = { target_type: "departament", target_dept: session.target_dept, team: null, team_id: null, label: DEPT_LABEL[session.target_dept] || session.target_dept };
  } else {
    a = { target_type: "echipa", target_dept: null, team: null, team_id: null, label: null };
  }
  const dept = resolveDept(a.target_dept, a.team && a.team.department);
  return { ...a, dept, created_by: createdBy };
}

// Public description for the UI (no leader ids).
function describe(a) {
  return { type: a.target_type, dept: a.target_dept, team_id: a.team_id, team_name: a.team ? a.team.name : null, label: a.label || "Toată echipa" };
}

// Audiences the actor may schedule for (the "Pentru" select).
function allowedTargets(actor) {
  const team = can(actor, "meetings.schedule", { target_type: "echipa" });
  const departments = Object.keys(DEPT_LABEL).filter((d) => can(actor, "meetings.schedule", { target_type: "departament", target_dept: d }));
  const groups = db.prepare("SELECT id FROM teams ORDER BY name COLLATE NOCASE").all()
    .map((r) => teamInfo(r.id))
    .filter((t) => can(actor, "meetings.schedule", { target_type: "grup", team: t }))
    .map((t) => ({ id: t.id, name: t.name, department: t.department }));
  return { team, departments, groups };
}

function leadsAGroup(actor) {
  return !!actor && !!db.prepare("SELECT 1 FROM team_members WHERE member_id = ? AND role = 'leader'").get(actor.id);
}

// Whether the Ședințe section (nav + pages) is shown to the actor (design-sedinte-v3.md §3).
function sectionAccess(actor) {
  return can(actor, "meetings.view_section", { leads_group: leadsAGroup(actor) });
}

module.exports = { DEPT_LABEL, fromRequest, ofSession, describe, allowedTargets, sectionAccess };
