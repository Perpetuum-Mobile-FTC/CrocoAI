// The ONLY definition of roles, groups and permissions (design v2 §2, §4).
// `can(actor, action, target)` is called by every domain service before doing anything.
const { DomainError } = require("./errors");

const ROLES = {
  team_leader: { label: "Team Leader", article: "Art. 5" },
  co_leader: { label: "Co-Leader", article: "Art. 6" },
  head_tech: { label: "Șef Departament Tehnic", article: "Art. 7" },
  head_nontech: { label: "Șef Departament Non-Tehnic", article: "Art. 8" },
  member: { label: "Membru", article: "Art. 9" },
  volunteer: { label: "Voluntar", article: "Art. 10" },
  mentor: { label: "Mentor", article: "Art. 11" },
  alumni: { label: "Alumni / Îndrumător", article: "Art. 12, 42.4" },
};

const LEADERS = ["team_leader", "co_leader"];
const MANAGERS = [...LEADERS, "head_tech", "head_nontech"];
const OVERSIGHT = [...MANAGERS, "mentor"];

// Privileged groups count only while the account is `activ` (A5, design-securitate-2026-10.md):
// a paused/left/alumni leader keeps the role label but none of the rights.
function isIn(actor, group) {
  return !!actor && actor.status === "activ" && group.includes(actor.role);
}

// A6: roles only the Team Leader may grant/remove, and accounts whose password only the TL may reset.
const PRIVILEGED_ROLES = ["team_leader", "co_leader", "mentor"];

function isLeader(actor) { return isIn(actor, LEADERS); }
function isManager(actor) { return isIn(actor, MANAGERS); }
function isOversight(actor) { return isIn(actor, OVERSIGHT); }

function isActiveOrAlumni(actor) {
  return !!actor && (actor.status === "activ" || actor.status === "pauza" || actor.status === "alumni");
}
function isSelf(actor, memberId) {
  return !!actor && Number(actor.id) === Number(memberId);
}

// --- Teme și grupuri (design-teme-grupuri.md §2) ---
const HEAD_DEPT = { head_tech: "tehnic", head_nontech: "non-tehnic" };
const GLOBAL_ASSIGNERS = [...LEADERS, "mentor"];
function headDept(actor) { return (actor && actor.status === "activ" && HEAD_DEPT[actor.role]) || null; }
function isGlobalAssigner(actor) { return isIn(actor, GLOBAL_ASSIGNERS); }
// Department heads have Team Leader rights over their department and its groups (decision 2026-10-13).
// `dept` = an object's resolved department: "tehnic" | "non-tehnic" | "mixt" (mixed group) | null (whole team).
function headOf(actor, dept) {
  return !!actor && actor.status === "activ" && !!dept && headDept(actor) === dept;
}
// Both heads SEE everything of mixed groups, but act there only as creator / TL / co-leader.
function headSees(actor, dept) {
  return headOf(actor, dept) || (dept === "mixt" && !!actor && actor.status === "activ" && !!headDept(actor));
}

// Returns true/false; services decide whether to throw. Kept simple and data-driven where
// possible, but written as explicit functions for action types that need the target.
const CHECKS = {
  "members.manage": (actor) => isLeader(actor),
  // A6: give/take team_leader, co_leader, mentor; reset/deactivate such an account (target: { role? }).
  "members.manage_privileged": (actor) => isIn(actor, ["team_leader"]),
  // ...with one exception: an active co-leader may bring a paused Team Leader back to 'activ' (only that).
  "members.restore_team_leader": (actor) => isIn(actor, ["co_leader"]),
  // Alert when the global registration-code cap blocks sign-ups (active Team Leader).
  "registration.limit_alert": (actor) => isIn(actor, ["team_leader"]),
  // A6: editing an account (phone, email, status, completion link, onboarding dialog): the owner edits their own
  // fields; a TL / co-leader / mentor account only the TL. target = the member row { id, role }.
  "members.edit_account": (actor, m) => !!actor && !!m && (isSelf(actor, m.id) || !PRIVILEGED_ROLES.includes(m.role) || CHECKS["members.manage_privileged"](actor)),
  // Changing a role (on top of members.manage): nobody changes their own role, except the TL. target: { member_id }
  "members.change_role": (actor, t) => !!actor && !!t && (!isSelf(actor, t.member_id) || CHECKS["members.manage_privileged"](actor)),
  "members.view_contacts": (actor, target) => isOversight(actor) || isSelf(actor, target && target.id),
  "members.view_directory": (actor) => !!actor,
  // target (optional): { dept } of the session. Heads are MANAGERS already; headOf kept explicit.
  "attendance.mark": (actor, t) => isManager(actor) || (!!t && headOf(actor, t.dept)),
  "attendance.view_all": (actor) => isOversight(actor),
  // One member's attendance stats: OVERSIGHT or the member themself. target: { member_id }
  "attendance.view_stats": (actor, t) => isOversight(actor) || (!!t && isSelf(actor, t.member_id)),
  "absence.request": (actor) => !!actor && actor.status === "activ",
  "absence.decide": (actor) => isManager(actor),
  // Absence requests: OVERSIGHT see everyone's, the rest only their own. target: { member_id }; no target = "sees all".
  "absences.view": (actor, t) => isOversight(actor) || (!!t && isSelf(actor, t.member_id)),
  "warnings.record": (actor) => isLeader(actor),
  "warnings.view": (actor, target) => isOversight(actor) || isSelf(actor, target && target.member_id),
  "tasks.assign": (actor) => isManager(actor),
  "tasks.manage_any": (actor) => isManager(actor),
  // A7: everyone else sees only tasks assigned to them or created by them (also /api/reminders).
  "tasks.view_all": (actor) => isManager(actor),
  // A task someone created for themselves: they edit it (title, due date, reminder). Reassigning = tasks.assign.
  "tasks.edit_own": (actor, task) => !!actor && !!task && task.created_by === actor.id && task.assigned_member_id === actor.id,
  // target = the task row. Edit (title, due date, reminder): MANAGERS or the creator of a task for themselves.
  "tasks.edit": (actor, task) => CHECKS["tasks.manage_any"](actor) || CHECKS["tasks.edit_own"](actor, task),
  // Mark done/pending, delete: the assignee or MANAGERS.
  "tasks.update_status": (actor, task) => CHECKS["tasks.manage_any"](actor) || (!!task && isSelf(actor, task.assigned_member_id)),
  "tasks.delete": (actor, task) => CHECKS["tasks.update_status"](actor, task),
  "events.manage": (actor) => isManager(actor),
  // Art. 51.1: emergency meetings are convened only by Team Leader, Co-Leader or an active mentor.
  "events.manage_urgenta": (actor) => isLeader(actor) || (!!actor && actor.role === "mentor" && actor.status === "activ"),
  "reminders.create_self": (actor) => !!actor,
  "reminders.create_other": (actor) => isManager(actor),
  "whatsapp.send": (actor) => isLeader(actor),
  "messages.view": (actor) => isLeader(actor),
  "wa_groups.manage": (actor) => isLeader(actor),
  "documents.review": (actor) => isLeader(actor),
  // A member's document list/status: the member or LEADERS. target: { member_id }
  "documents.view": (actor, t) => CHECKS["documents.review"](actor) || (!!t && isSelf(actor, t.member_id)),
  // Art. 41.4: the medical sheet is readable by the Team Leader and active mentors (emergency use).
  "documents.medical_other": (actor) => isIn(actor, ["team_leader", "mentor"]),
  "documents.medical_upload_other": (actor) => isIn(actor, ["team_leader"]), // upload for someone else stays TL only
  // Upload for a member: anyone for themselves; for someone else the medical sheet is TL only, the rest LEADERS.
  // Art. 41.8: nobody uploads a medical sheet for a member who left (status 'iesit'; it would be destroyed again).
  // target: { member_id, type_key, member_status? }
  "documents.upload": (actor, t) => !!t && !(t.type_key === "fisa_medicala" && t.member_status === "iesit") && (isSelf(actor, t.member_id) || (t.type_key === "fisa_medicala"
    ? CHECKS["documents.medical_upload_other"](actor) : CHECKS["members.manage"](actor))),
  // Open a document file: the owner; someone else's medical sheet = documents.medical_other, other types = LEADERS.
  // target = the member_documents row { member_id, type_key }.
  "documents.view_file": (actor, doc) => !!doc && (isSelf(actor, doc.member_id) || (doc.type_key === "fisa_medicala"
    ? CHECKS["documents.medical_other"](actor) : CHECKS["documents.review"](actor))),
  // Art. 41.2: the Team Leader is responsible for personal data -> reads the access log of medical sheets.
  "audit_log.view": (actor) => isIn(actor, ["team_leader"]),
  // A member's guardians: LEADERS or the member themself (reading them = members.view_contacts). target: { member_id }
  "guardians.manage": (actor, t) => CHECKS["members.manage"](actor) || (!!t && isSelf(actor, t.member_id)),
  "ai_usage.view": (actor) => isLeader(actor),
  // Who receives the AI crisis signal (design-ai-hardening.md §1): the active Team Leader + active mentors.
  "ai.crisis_notify": (actor) => isIn(actor, ["team_leader", "mentor"]),
  "regulament.read": (actor) => !!actor,
  "ftc_manual.manage": (actor) => isLeader(actor), // force a check + see version history (Admin panel)

  // --- Faza 2 (design-phase2.md §2) ---
  // Ședințe + proces-verbal (Art. 19, 47.4, 49, Anexa 7)
  "meetings.manage": (actor) => isManager(actor), // agendă, audio, transcriere, ciornă PV
  // Heads are MANAGERS, so they already manage every meeting (incl. whole-team ones).
  // „Verificat de Team Leader” (Anexa 7) + the head of the meeting's department (target: { dept }).
  "meetings.approve": (actor, t) => isLeader(actor) || (!!t && headOf(actor, t.dept)),
  "meetings.view_drafts": (actor) => isOversight(actor),
  "meetings.view_upcoming": (actor) => !!actor && actor.status === "activ", // dată/loc/agendă ședințe viitoare
  "meetings.view_final": (actor) => isActiveOrAlumni(actor), // Art. 49.3: PV accesibile membrilor activi
  // --- Ședințe v3 (design-sedinte-v3.md §1, §3) ---
  // target: { target_type: "echipa"|"departament"|"grup", target_dept?, team?: { department, leader_ids } }
  // Same rule as assignments.create; the whole team = LEADERS + mentors + heads of department.
  "meetings.schedule": (actor, t) => {
    if (!actor || actor.status !== "activ") return false;
    if (isGlobalAssigner(actor)) return true;
    const d = headDept(actor);
    if (!t || t.target_type === "echipa") return !!d;
    return CHECKS["assignments.create"](actor, t);
  },
  // Modify / cancel / run attendance (QR, marking, close/reopen): the schedule rule applied to the
  // meeting's audience, plus the meeting's creator. target = schedule target + { created_by }.
  "meetings.organize": (actor, t) => CHECKS["meetings.schedule"](actor, t) ||
    (!!t && isSelf(actor, t.created_by) && actor.status === "activ"),
  // Full meeting page (attendance situation, recording, PV draft): oversight + organizers.
  "meetings.view": (actor, t) => isOversight(actor) || CHECKS["meetings.organize"](actor, t),
  // The Ședințe section of the platform: oversight + group leaders (for their group's meetings).
  // target: { leads_group: boolean }
  "meetings.view_section": (actor, t) => isOversight(actor) || (!!actor && actor.status === "activ" && !!t && !!t.leads_group),
  "meetings.scan": (actor) => !!actor && actor.status === "activ", // any active account, invited or extra
  // Poze (Art. 45.4, 59)
  "photos.view": (actor) => isActiveOrAlumni(actor),
  "photos.upload": (actor) => !!actor && actor.status === "activ",
  "photos.tag_any": (actor) => isManager(actor),
  "photos.delete_any": (actor) => isLeader(actor),
  "photos.publish": (actor) => isLeader(actor), // Art. 59.5: distribuire doar cu aprobarea TL
  // target = the photo row { uploaded_by }: the uploader acts on their own photos, the rest needs the *_any right.
  "photos.tag": (actor, p) => CHECKS["photos.tag_any"](actor) || (!!p && isSelf(actor, p.uploaded_by)),
  "photos.delete": (actor, p) => CHECKS["photos.delete_any"](actor) || (!!p && isSelf(actor, p.uploaded_by)),
  // The full-size original: the uploader or LEADERS (everyone else gets the reduced variant).
  "photos.download_original": (actor, p) => CHECKS["photos.publish"](actor) || (!!p && isSelf(actor, p.uploaded_by)),
  // Resurse: bibliotecă comună; văd toți membrii (și mentorii), gestionează conducerea activă (decizie Luca 2026-10-16)
  "resources.view": (actor) => isActiveOrAlumni(actor) || isOversight(actor),
  "resources.manage": (actor) => isOversight(actor) && actor.status === "activ",
  // Onboarding (Art. 14, 43) + gestionare grupuri WhatsApp
  "onboarding.start": (actor) => isLeader(actor),
  "onboarding.manage": (actor) => isManager(actor), // Art. 43.1: coordonat de Șeful de Departament
  // A member's onboarding checklist: MANAGERS or the member themself. target: { member_id }
  "onboarding.view": (actor, t) => CHECKS["onboarding.manage"](actor) || (!!t && isSelf(actor, t.member_id)),
  // --- Pachet B (docs/design-pachet-b.md) ---
  // Anunțuri (Art. 23.1): TL / co-leader / mentori -> toată echipa sau un departament; șefii -> doar departamentul lor.
  // target: { audience: "echipa"|"tehnic"|"non-tehnic" }; fără target = „poate publica ceva”.
  "announcements.publish": (actor, t) => isGlobalAssigner(actor) || (!!headDept(actor) && (!t || t.audience === headDept(actor))),
  // Vede un anunț: „echipa” -> orice cont activ sau în pauză; departament -> acel departament + „ambele” + conducerea
  // lui (TL/co-leader/mentori, șeful departamentului). target = rândul anunțului.
  "announcements.view": (actor, a) => {
    if (!actor || !["activ", "pauza"].includes(actor.status) || !a) return false;
    if (a.audience === "echipa") return true;
    return isGlobalAssigner(actor) || headDept(actor) === a.audience || isSelf(actor, a.author_id) ||
      actor.department === a.audience || actor.department === "ambele";
  },
  // Șterge un anunț (greșeală de publicare): autorul sau TL / co-leader. target = rândul anunțului.
  "announcements.delete": (actor, a) => isLeader(actor) || (!!a && isSelf(actor, a.author_id) && actor.status === "activ"),
  // Termene (numărătoare inversă pe Acasă): TL / co-leader / șefii de departament.
  "deadlines.manage": (actor) => isManager(actor),

  // --- Teme și grupuri (design-teme-grupuri.md §2) ---
  "groups.view_all": (actor) => isGlobalAssigner(actor) || !!headDept(actor),
  // target: { department, member_departments? } — heads only inside their department.
  "groups.manage": (actor, t) => {
    if (isGlobalAssigner(actor)) return true;
    const d = headDept(actor);
    if (!d) return false;
    if (!t) return true;
    if (t.department !== d) return false;
    return (t.member_departments || []).every((x) => x === d || x === "ambele");
  },
  // target: { target_type, target_dept?, team?: { department, leader_ids } }
  "assignments.create": (actor, t) => {
    if (!actor || actor.status !== "activ") return false;
    if (isGlobalAssigner(actor)) return true;
    const d = headDept(actor);
    if (!t) return !!d;
    if (t.target_type === "departament") return !!d && t.target_dept === d;
    if (t.target_type === "grup" && t.team) {
      return (!!d && t.team.department === d) || t.team.leader_ids.map(Number).includes(Number(actor.id));
    }
    return false;
  },
  // Edit, close, delete, add new members, review. target: { created_by, dept } (row + resolved department).
  "assignments.manage": (actor, a) => isLeader(actor) ||
    (!!actor && !!a && (Number(a.created_by) === Number(actor.id) || headOf(actor, a.dept))),
  // Global oversight of every assignment; heads see their own department + mixed groups (view_dept).
  "assignments.view_all": (actor) => isLeader(actor) || isIn(actor, ["mentor"]),
  // target: { dept } - the assignment's resolved department. No target: "is a head at all" (list guard).
  "assignments.view_dept": (actor, t) => (t ? headSees(actor, t.dept) : !!headDept(actor)),
  "assignments.review": (actor, t) => CHECKS["assignments.manage"](actor, t),
  // Reading a submission (besides oversight/manage): individual -> its owner, group -> any group member.
  // target: { mode, member_id, is_group_member }
  "submissions.view": (actor, t) => !!actor && !!t && (t.mode === "grup" ? !!t.is_group_member : isSelf(actor, t.member_id)),
  // target: { status, mode, member_id, is_group_member }
  "submissions.work": (actor, t) => !!actor && !!t && t.status === "activa" &&
    (t.mode === "individual" ? isSelf(actor, t.member_id) : !!t.is_group_member),
};

const ACTIONS = Object.keys(CHECKS);

// Actor-only rights the SPA needs to show/hide controls (GET /api/auth/me `permissions`). The server still
// re-checks every action with its real target; this only replaces role lists hard-coded in the UI.
const UI_ACTIONS = [
  "members.manage", "members.view_contacts", "attendance.mark", "attendance.view_all", "absence.decide",
  "warnings.record", "tasks.assign", "tasks.manage_any", "events.manage", "events.manage_urgenta",
  "documents.review", "documents.medical_other", "audit_log.view", "wa_groups.manage", "ai_usage.view",
  "ftc_manual.manage", "meetings.manage", "onboarding.start", "onboarding.manage", "photos.tag_any",
  "photos.delete_any", "photos.publish", "deadlines.manage", "assignments.view_dept",
];
function uiPermissions(actor) {
  return Object.fromEntries(UI_ACTIONS.map((a) => [a, can(actor, a)]));
}

// can(actor, action, target?) -> boolean
function can(actor, action, target) {
  const check = CHECKS[action];
  if (!check) throw new Error(`policy.can: unknown action "${action}"`);
  return !!check(actor, target);
}

// Throws DomainError(FORBIDDEN) if `can` is false. Convenience for services.
function assertCan(actor, action, target, message) {
  if (!can(actor, action, target)) {
    throw new DomainError("FORBIDDEN", message || "Nu ai permisiunea necesară pentru această acțiune.");
  }
}

module.exports = { ROLES, LEADERS, MANAGERS, OVERSIGHT, PRIVILEGED_ROLES, HEAD_DEPT, ACTIONS, UI_ACTIONS, isIn, isLeader, isManager, isOversight, isSelf, headOf, headSees, can, assertCan, uiPermissions };
