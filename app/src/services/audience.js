// Audience lookups over the DB: a group's info, the department of a session/assignment, and the
// notification recipients (leaders, department heads). Status rules come from policy (privileged = 'activ').
const db = require("../db");
const policy = require("../domain/policy");
const { headRolesFor, resolveDept } = require("../domain/audience");

function teamInfo(teamId) {
  const t = teamId ? db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) : null;
  if (!t) return null;
  const leader_ids = db.prepare("SELECT member_id FROM team_members WHERE team_id = ? AND role = 'leader'").all(t.id).map((r) => r.member_id);
  return { ...t, leader_ids };
}

function teamDept(teamId) {
  const t = teamId ? db.prepare("SELECT department FROM teams WHERE id = ?").get(teamId) : null;
  return t ? t.department : null;
}

// THE department of an attendance session / meeting session (target_dept or the group's department).
function sessionDept(session) {
  return resolveDept(session.target_dept, session.target_dept ? null : teamDept(session.team_id));
}

// THE department of an assignment (target_dept or the target group's department).
function assignmentDept(a) {
  if (a.target_type === "departament") return a.target_dept;
  return resolveDept(null, teamDept(a.target_team_id));
}

// Members holding one of `roles` that the policy counts as active in that group.
function activeWithRoles(roles) {
  return db.prepare(`SELECT * FROM members WHERE role IN (${roles.map(() => "?").join(",")}) ORDER BY id`).all(...roles)
    .filter((m) => policy.isIn(m, roles));
}

const activeLeaders = () => activeWithRoles(policy.LEADERS); // Team Leader + Co-Leader
const activeTeamLeaders = () => activeWithRoles(["team_leader"]);
const leaderIds = () => activeLeaders().map((m) => m.id);
// Active head(s) of a member's department ('ambele' / unknown -> both heads).
const headsFor = (dept) => activeWithRoles(headRolesFor(dept));

// Every member for whom policy allows `action` (on `target`).
function membersWhoCan(action, target) {
  return db.prepare("SELECT * FROM members ORDER BY id").all().filter((m) => policy.can(m, action, target));
}

module.exports = { teamInfo, teamDept, sessionDept, assignmentDept, activeWithRoles, activeLeaders, activeTeamLeaders, leaderIds, headsFor, membersWhoCan };
