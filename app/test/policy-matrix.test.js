// Full policy matrix (cleanup F1): EVERY action in policy.CHECKS x every role x status (activ / pauza /
// alumni / iesit), against an expected-outcome table written by hand below. Adding an action to policy.js
// without an entry here fails the first test - decide who may do it, then write it down.
const { test } = require("node:test");
const assert = require("node:assert");
const { can, ACTIONS, ROLES, UI_ACTIONS, uiPermissions } = require("../src/domain/policy");

const ALL_ROLES = Object.keys(ROLES);
const STATUSES = ["activ", "pauza", "alumni", "iesit"];
const LEADERS = ["team_leader", "co_leader"];
const HEADS = ["head_tech", "head_nontech"];
const MANAGERS = [...LEADERS, ...HEADS];
const OVERSIGHT = [...MANAGERS, "mentor"];
const GLOBAL = [...LEADERS, "mentor"]; // team-wide assigners (teme, ședințe, anunțuri)

// Expected sets of "role:status" strings.
const combos = (roles, statuses) => roles.flatMap((r) => statuses.map((s) => `${r}:${s}`));
const ACTIVE = (roles) => combos(roles, ["activ"]);
const ANY = combos(ALL_ROLES, STATUSES);
const NONE = [];
const ALL_ACTIVE = ACTIVE(ALL_ROLES);
const NOT_LEFT = combos(ALL_ROLES, ["activ", "pauza", "alumni"]);
const ACTIVE_OR_PAUSED = combos(ALL_ROLES, ["activ", "pauza"]);

// The actor is always member #1; "self" targets point at 1, "other" targets at 2.
const SELF = 1;
const OTHER = 2;

// action -> list of [label, target, expected]. `target` undefined = actor-only check.
const T = (expected) => [["-", undefined, expected]];
const EXPECTED = {
  "members.manage": T(ACTIVE(LEADERS)),
  "members.manage_privileged": T(ACTIVE(["team_leader"])),
  "members.restore_team_leader": T(ACTIVE(["co_leader"])),
  "registration.limit_alert": T(ACTIVE(["team_leader"])),
  "members.edit_account": [["self (privileged)", { id: SELF, role: "team_leader" }, ANY], ["other member", { id: OTHER, role: "member" }, ANY],
    ["other privileged", { id: OTHER, role: "mentor" }, ACTIVE(["team_leader"])]],
  "members.change_role": [["self", { member_id: SELF }, ACTIVE(["team_leader"])], ["other", { member_id: OTHER }, ANY]],
  "members.view_contacts": [["other", { id: OTHER }, ACTIVE(OVERSIGHT)], ["self", { id: SELF }, ANY], ["-", undefined, ACTIVE(OVERSIGHT)]],
  "members.view_directory": T(ANY),
  "attendance.mark": [["-", undefined, ACTIVE(MANAGERS)], ["dept", { dept: "tehnic" }, ACTIVE(MANAGERS)]],
  "attendance.view_all": T(ACTIVE(OVERSIGHT)),
  "attendance.view_stats": [["other", { member_id: OTHER }, ACTIVE(OVERSIGHT)], ["self", { member_id: SELF }, ANY]],
  "absence.request": T(ALL_ACTIVE),
  "absence.decide": T(ACTIVE(MANAGERS)),
  "absences.view": [["all", undefined, ACTIVE(OVERSIGHT)], ["other", { member_id: OTHER }, ACTIVE(OVERSIGHT)], ["self", { member_id: SELF }, ANY]],
  "warnings.record": T(ACTIVE(LEADERS)),
  "warnings.view": [["other", { member_id: OTHER }, ACTIVE(OVERSIGHT)], ["self", { member_id: SELF }, ANY]],
  "tasks.assign": T(ACTIVE(MANAGERS)),
  "tasks.manage_any": T(ACTIVE(MANAGERS)),
  "tasks.view_all": T(ACTIVE(MANAGERS)),
  "tasks.edit_own": [["own", { created_by: SELF, assigned_member_id: SELF }, ANY], ["assigned", { created_by: OTHER, assigned_member_id: SELF }, NONE]],
  "tasks.edit": [["own", { created_by: SELF, assigned_member_id: SELF }, ANY], ["assigned", { created_by: OTHER, assigned_member_id: SELF }, ACTIVE(MANAGERS)]],
  "tasks.update_status": [["assignee", { created_by: OTHER, assigned_member_id: SELF }, ANY], ["other", { created_by: SELF, assigned_member_id: OTHER }, ACTIVE(MANAGERS)]],
  "tasks.delete": [["assignee", { created_by: OTHER, assigned_member_id: SELF }, ANY], ["other", { created_by: SELF, assigned_member_id: OTHER }, ACTIVE(MANAGERS)]],
  "events.manage": T(ACTIVE(MANAGERS)),
  "events.manage_urgenta": T(ACTIVE(GLOBAL)), // Art. 51.1
  "reminders.create_self": T(ANY),
  "reminders.create_other": T(ACTIVE(MANAGERS)),
  "whatsapp.send": T(ACTIVE(LEADERS)),
  "messages.view": T(ACTIVE(LEADERS)),
  "wa_groups.manage": T(ACTIVE(LEADERS)),
  "documents.review": T(ACTIVE(LEADERS)),
  "documents.view": [["other", { member_id: OTHER }, ACTIVE(LEADERS)], ["self", { member_id: SELF }, ANY]],
  "documents.medical_other": T(ACTIVE(["team_leader", "mentor"])), // Art. 41.4
  "documents.medical_upload_other": T(ACTIVE(["team_leader"])),
  "documents.upload": [
    ["self medical", { member_id: SELF, type_key: "fisa_medicala" }, ANY],
    ["other medical", { member_id: OTHER, type_key: "fisa_medicala" }, ACTIVE(["team_leader"])],
    ["other anexa", { member_id: OTHER, type_key: "anexa5" }, ACTIVE(LEADERS)],
    ["medical, member iesit", { member_id: SELF, type_key: "fisa_medicala", member_status: "iesit" }, NONE], // Art. 41.8
    ["anexa, member iesit", { member_id: SELF, type_key: "anexa5", member_status: "iesit" }, ANY],
    ["no target", undefined, NONE],
  ],
  "documents.view_file": [
    ["own medical", { member_id: SELF, type_key: "fisa_medicala" }, ANY],
    ["other medical", { member_id: OTHER, type_key: "fisa_medicala" }, ACTIVE(["team_leader", "mentor"])],
    ["other anexa", { member_id: OTHER, type_key: "anexa5" }, ACTIVE(LEADERS)],
  ],
  "audit_log.view": T(ACTIVE(["team_leader"])), // Art. 41.2
  "guardians.manage": [["other", { member_id: OTHER }, ACTIVE(LEADERS)], ["self", { member_id: SELF }, ANY]],
  "ai_usage.view": T(ACTIVE(LEADERS)),
  "ai.crisis_notify": T(ACTIVE(["team_leader", "mentor"])),
  "regulament.read": T(ANY),
  "ftc_manual.manage": T(ACTIVE(LEADERS)),
  "meetings.manage": T(ACTIVE(MANAGERS)),
  "meetings.approve": [["-", undefined, ACTIVE(LEADERS)], ["tehnic", { dept: "tehnic" }, ACTIVE([...LEADERS, "head_tech"])]],
  "meetings.view_drafts": T(ACTIVE(OVERSIGHT)),
  "meetings.view_upcoming": T(ALL_ACTIVE),
  "meetings.view_final": T(NOT_LEFT), // Art. 49.3
  "meetings.schedule": [
    ["-", undefined, ACTIVE(OVERSIGHT)],
    ["echipa", { target_type: "echipa" }, ACTIVE(OVERSIGHT)],
    ["dept tehnic", { target_type: "departament", target_dept: "tehnic" }, ACTIVE([...GLOBAL, "head_tech"])],
  ],
  "meetings.organize": [
    ["own", { target_type: "echipa", created_by: SELF }, ALL_ACTIVE],
    ["other's", { target_type: "echipa", created_by: OTHER }, ACTIVE(OVERSIGHT)],
  ],
  "meetings.view": [["other's", { target_type: "echipa", created_by: OTHER }, ACTIVE(OVERSIGHT)]],
  "meetings.view_section": [["-", undefined, ACTIVE(OVERSIGHT)], ["group leader", { leads_group: true }, ALL_ACTIVE]],
  "meetings.scan": T(ALL_ACTIVE),
  "photos.view": T(NOT_LEFT),
  "photos.upload": T(ALL_ACTIVE),
  "photos.tag_any": T(ACTIVE(MANAGERS)),
  "photos.delete_any": T(ACTIVE(LEADERS)),
  "photos.publish": T(ACTIVE(LEADERS)), // Art. 59.5
  "photos.tag": [["own", { uploaded_by: SELF }, ANY], ["other's", { uploaded_by: OTHER }, ACTIVE(MANAGERS)]],
  "photos.delete": [["own", { uploaded_by: SELF }, ANY], ["other's", { uploaded_by: OTHER }, ACTIVE(LEADERS)]],
  "photos.download_original": [["own", { uploaded_by: SELF }, ANY], ["other's", { uploaded_by: OTHER }, ACTIVE(LEADERS)]],
  "resources.view": T(NOT_LEFT),
  "resources.manage": T(ACTIVE(OVERSIGHT)),
  "onboarding.start": T(ACTIVE(LEADERS)),
  "onboarding.manage": T(ACTIVE(MANAGERS)), // Art. 43.1
  "onboarding.view": [["other", { member_id: OTHER }, ACTIVE(MANAGERS)], ["self", { member_id: SELF }, ANY]],
  "announcements.publish": [["-", undefined, ACTIVE(OVERSIGHT)], ["tehnic", { audience: "tehnic" }, ACTIVE([...GLOBAL, "head_tech"])]],
  "announcements.view": [
    ["echipa", { audience: "echipa", author_id: OTHER }, ACTIVE_OR_PAUSED],
    ["tehnic", { audience: "tehnic", author_id: OTHER }, ACTIVE([...GLOBAL, "head_tech"])],
  ],
  "announcements.delete": [["other's", { author_id: OTHER }, ACTIVE(LEADERS)], ["own", { author_id: SELF }, ALL_ACTIVE]],
  "deadlines.manage": T(ACTIVE(MANAGERS)),
  "groups.view_all": T(ACTIVE(OVERSIGHT)),
  "groups.manage": [["-", undefined, ACTIVE(OVERSIGHT)], ["tehnic", { department: "tehnic" }, ACTIVE([...GLOBAL, "head_tech"])]],
  "assignments.create": [
    ["-", undefined, ACTIVE(OVERSIGHT)],
    ["dept non-tehnic", { target_type: "departament", target_dept: "non-tehnic" }, ACTIVE([...GLOBAL, "head_nontech"])],
  ],
  // The creator keeps managing their own assignment whatever their status (existing behaviour, documented here).
  "assignments.manage": [["own", { created_by: SELF, dept: "tehnic" }, ANY], ["other's tehnic", { created_by: OTHER, dept: "tehnic" }, ACTIVE([...LEADERS, "head_tech"])]],
  "assignments.view_all": T(ACTIVE(GLOBAL)),
  "assignments.view_dept": [["-", undefined, ACTIVE(HEADS)], ["mixt", { dept: "mixt" }, ACTIVE(HEADS)], ["tehnic", { dept: "tehnic" }, ACTIVE(["head_tech"])]],
  "assignments.review": [["own", { created_by: SELF, dept: "tehnic" }, ANY], ["other's tehnic", { created_by: OTHER, dept: "tehnic" }, ACTIVE([...LEADERS, "head_tech"])]],
  "submissions.view": [
    ["own individual", { mode: "individual", member_id: SELF }, ANY],
    ["someone else's", { mode: "individual", member_id: OTHER }, NONE],
    ["group, member of it", { mode: "grup", member_id: null, is_group_member: true }, ANY],
    ["group, outsider", { mode: "grup", member_id: null, is_group_member: false }, NONE],
  ],
  "submissions.work": [
    ["own individual", { status: "activa", mode: "individual", member_id: SELF }, ANY],
    ["someone else's", { status: "activa", mode: "individual", member_id: OTHER }, NONE],
    ["closed", { status: "inchisa", mode: "individual", member_id: SELF }, NONE],
  ],
};

test("every policy action has an entry in the expected-outcome table (and no stale entries)", () => {
  const missing = ACTIONS.filter((a) => !(a in EXPECTED));
  const stale = Object.keys(EXPECTED).filter((a) => !ACTIONS.includes(a));
  assert.deepEqual(missing, [], `actions without an expected outcome: ${missing.join(", ")}`);
  assert.deepEqual(stale, [], `table entries for actions that no longer exist: ${stale.join(", ")}`);
});

for (const action of ACTIONS) {
  test(`policy matrix: ${action}`, () => {
    for (const [label, target, expected] of EXPECTED[action] || []) {
      const allowed = new Set(expected);
      for (const role of ALL_ROLES) {
        for (const status of STATUSES) {
          const actor = { id: SELF, role, status };
          assert.equal(can(actor, action, target), allowed.has(`${role}:${status}`), `${action} [${label}] ${role}/${status}`);
        }
      }
    }
  });
}

test("no actor -> every action refused", () => {
  for (const action of ACTIONS) {
    for (const [label, target] of EXPECTED[action] || []) assert.equal(can(null, action, target), false, `${action} [${label}]`);
  }
});

test("uiPermissions: one boolean per UI action, equal to can() without a target", () => {
  for (const role of ALL_ROLES) {
    for (const status of STATUSES) {
      const actor = { id: SELF, role, status };
      const p = uiPermissions(actor);
      assert.deepEqual(Object.keys(p).sort(), [...UI_ACTIONS].sort());
      for (const a of UI_ACTIONS) assert.equal(p[a], can(actor, a), `${a} ${role}/${status}`);
    }
  }
  for (const a of UI_ACTIONS) assert.ok(ACTIONS.includes(a), `UI action ${a} exists in policy`);
});
