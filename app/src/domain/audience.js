// Pure audience vocabulary (no DB): departments, their labels and which head role covers which department.
// The role -> department map itself lives ONLY in policy.HEAD_DEPT.
const { HEAD_DEPT } = require("./policy");

const DEPARTMENTS = ["tehnic", "non-tehnic"];
const DEPT_LABEL = { tehnic: "Departament Tehnic", "non-tehnic": "Departament Non-Tehnic" };
// department -> head role ({ tehnic: "head_tech", "non-tehnic": "head_nontech" })
const HEAD_ROLE = Object.fromEntries(Object.entries(HEAD_DEPT).map(([role, dept]) => [dept, role]));

// Head roles responsible for a member's department. 'ambele' and an unknown/NULL department -> both heads
// (a NULL department used to fall through to head_nontech only).
function headRolesFor(dept) {
  return HEAD_ROLE[dept] ? [HEAD_ROLE[dept]] : Object.keys(HEAD_DEPT);
}

// THE department of a session / assignment / meeting: the explicit target department, else the group's
// department ("mixt" for mixed groups), else null (whole team).
function resolveDept(targetDept, teamDept) {
  return targetDept || teamDept || null;
}

module.exports = { DEPARTMENTS, DEPT_LABEL, HEAD_ROLE, headRolesFor, resolveDept };
