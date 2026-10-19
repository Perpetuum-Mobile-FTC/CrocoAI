// Members, guardians, status changes, import. Every function takes `actor` first.
const bcrypt = require("bcryptjs");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { can, assertCan, ROLES, PRIVILEGED_ROLES } = require("../domain/policy");
const { passwordError } = require("../domain/rules");
const { normalizePhone } = require("../domain/phone");
const { generateUsername, randomPassword } = require("./username");
const profile = require("../domain/profile");
const documents = require("./documents");
const auditLog = require("./audit-log");

const VALID_ROLES = Object.keys(ROLES);
const VALID_STATUSES = ["activ", "pauza", "iesit", "alumni"];
const ONLY_TL = "Doar Team Leader-ul poate schimba rolurile Team Leader, Co-Leader și Mentor sau administra aceste conturi.";

// A6: touching a team_leader/co_leader/mentor account or role is the Team Leader's call.
function assertCanTouchRole(actor, ...roles) {
  if (roles.some((r) => PRIVILEGED_ROLES.includes(r))) assertCan(actor, "members.manage_privileged", null, ONLY_TL);
}

// Any edit of a privileged account (phone = the bot's identity for that person, email, status, role) is the
// TL's; the account owner may still edit their own non-role fields (policy members.edit_account).
function assertCanEditAccount(actor, member) {
  assertCan(actor, "members.edit_account", member, ONLY_TL);
}

// The team always keeps an active Team Leader: the last one can't pause, leave or demote themselves.
function assertNotLastTeamLeader(member) {
  if (member.role !== "team_leader" || member.status !== "activ") return;
  const others = db.prepare("SELECT COUNT(*) c FROM members WHERE role = 'team_leader' AND status = 'activ' AND id != ?").get(member.id).c;
  if (!others) throw new DomainError("INVALID", "Nu se poate: este singurul Team Leader activ. Numește întâi alt Team Leader.");
}

function hasPhone(member) {
  return !!member && !!member.phone && !member.phone.startsWith("pending-");
}

// A3: the bot sends reminders/notices on WhatsApp only to a verified phone (code at registration,
// set by a leader, or an account that existed before verification - migration 022). null = in-app only.
function whatsappPhone(member) {
  return hasPhone(member) && member.phone_verified_at ? member.phone : null;
}

function bumpTokenVersion(memberId) {
  db.prepare("UPDATE members SET token_version = token_version + 1 WHERE id = ?").run(memberId);
}

// Login (design v2 §2): username OR phone (normalized); an exact phone match wins over a username that
// happens to look like that phone. Returns the member (last_login updated) or null.
function authenticate(identifier, password, allowedStatuses) {
  const id = String(identifier).trim();
  const digits = normalizePhone(id);
  const member = (digits && db.prepare("SELECT * FROM members WHERE phone = ?").get(digits))
    || db.prepare("SELECT * FROM members WHERE (username = ? OR phone = ?)").get(id.toLowerCase(), digits || id);
  if (!member || !allowedStatuses.includes(member.status) || !member.password_hash || !bcrypt.compareSync(password, member.password_hash)) return null;
  db.prepare("UPDATE members SET last_login = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(member.id);
  return member;
}

function getRaw(id) {
  return db.prepare("SELECT * FROM members WHERE id = ?").get(id);
}

function requireRaw(id) {
  const m = getRaw(id);
  if (!m) throw new DomainError("NOT_FOUND", "Membru negăsit.");
  return m;
}

// Admin list (LEADERS): every account incl. contacts and login state.
function adminList(actor) {
  assertCan(actor, "members.manage");
  return db.prepare(`
    SELECT id, full_name AS name, username, phone, email, class, school, department, role, status, active, must_change_password, last_login
    FROM members ORDER BY full_name COLLATE NOCASE
  `).all();
}

// Directory: name, role, department, status - visible to any authenticated user.
function listDirectory(actor) {
  assertCan(actor, "members.view_directory");
  const rows = db.prepare(`
    SELECT id, full_name AS name, role, department, status, class, school
    FROM members ORDER BY full_name COLLATE NOCASE
  `).all();
  const teamRows = db.prepare("SELECT member_id, team_id FROM team_members").all();
  const teamsByMember = new Map();
  for (const t of teamRows) {
    if (!teamsByMember.has(t.member_id)) teamsByMember.set(t.member_id, []);
    teamsByMember.get(t.member_id).push(t.team_id);
  }
  for (const r of rows) r.team_ids = teamsByMember.get(r.id) || [];
  return rows;
}

function toContactFields(m) {
  return {
    phone: hasPhone(m) ? m.phone : null,
    email: m.email,
    birthdate: m.birthdate,
    school: m.school,
    class: m.class,
    guardians: db.prepare("SELECT id, name, relation, phone, email FROM guardians WHERE member_id = ?").all(m.id),
  };
}

// Full profile. Contacts included only if actor is OVERSIGHT or the member themself.
function getProfile(actor, id) {
  const m = requireRaw(id);
  const base = {
    id: m.id,
    name: m.full_name,
    username: m.username,
    role: m.role,
    department: m.department,
    status: m.status,
    pause_until: m.pause_until,
    joined_at: m.joined_at,
    left_at: m.left_at,
    notes: can(actor, "members.manage") ? m.notes : undefined,
  };
  if (can(actor, "members.view_contacts", m)) {
    Object.assign(base, toContactFields(m));
  }
  return base;
}

function create(actor, data) {
  assertCan(actor, "members.manage");
  const { name, phone, role, email, department, class: cls, school, birthdate } = data || {};
  if (!name || !name.trim()) throw new DomainError("INVALID", "Numele e obligatoriu.");
  const finalRole = VALID_ROLES.includes(role) ? role : "volunteer";
  assertCanTouchRole(actor, finalRole);
  let digits = null;
  if (phone) {
    digits = normalizePhone(phone);
    if (!digits) throw new DomainError("INVALID", "Telefon invalid.");
    if (db.prepare("SELECT 1 FROM members WHERE phone = ?").get(digits)) {
      throw new DomainError("INVALID", "Există deja un membru cu acest telefon.");
    }
  }
  const finalPhone = digits || `pending-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const username = generateUsername(name);
  // A1: random temporary password, shown once to the leader; must be changed at first login.
  const password = randomPassword();
  const hash = bcrypt.hashSync(password, 10);
  // A phone typed in by a leader counts as verified (only self-registration needs the WhatsApp code).
  const info = db.prepare(`
    INSERT INTO members (full_name, username, phone, email, department, class, school, birthdate, role, auth_role, status, must_change_password, password_hash, joined_at, phone_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activ', 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END)
  `).run(name.trim(), username, finalPhone, email || null, department || "ambele", cls || null, school || null, birthdate || null, finalRole, finalRole, hash, digits ? 1 : 0);
  return { id: info.lastInsertRowid, username, password };
}

function update(actor, id, data) {
  assertCan(actor, "members.manage");
  const m = requireRaw(id);
  assertCanEditAccount(actor, m);
  const { name, phone, role, email, department, notes, class: cls, school, birthdate } = data || {};
  let digits = m.phone;
  if (phone !== undefined && phone !== null) {
    digits = normalizePhone(phone);
    if (!digits) throw new DomainError("INVALID", "Telefon invalid.");
    const other = db.prepare("SELECT id FROM members WHERE phone = ? AND id != ?").get(digits, id);
    if (other) throw new DomainError("INVALID", "Alt membru folosește deja acest telefon.");
  }
  const finalRole = role !== undefined ? (VALID_ROLES.includes(role) ? role : m.role) : m.role;
  if (finalRole !== m.role) {
    assertCan(actor, "members.change_role", { member_id: id }, "Nu îți poți schimba singur rolul.");
    assertCanTouchRole(actor, m.role, finalRole);
    assertNotLastTeamLeader(m);
  }
  db.prepare(`
    UPDATE members SET requested_role = CASE WHEN ? THEN NULL ELSE requested_role END, full_name=?, phone=?, role=?, auth_role=?, email=?, department=?, notes=?, class=?, school=?, birthdate=?,
      phone_verified_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE phone_verified_at END
    WHERE id = ?
  `).run(
    finalRole !== m.role ? 1 : 0,
    name !== undefined ? name : m.full_name,
    digits,
    finalRole, finalRole,
    email !== undefined ? email : m.email,
    department !== undefined ? department : m.department,
    notes !== undefined ? notes : m.notes,
    cls !== undefined ? cls : m.class,
    school !== undefined ? school : m.school,
    birthdate !== undefined ? birthdate : m.birthdate,
    digits !== m.phone ? 1 : 0, // a phone set by a leader counts as verified
    id
  );
  return getRaw(id);
}

// „Contul meu”: the owner edits their own non-identity fields (profile.OWN_EDITABLE), policy members.edit_account.
function updateOwn(actor, data) {
  const m = requireRaw(actor.id);
  assertCanEditAccount(actor, m);
  const result = profile.validateOwnEdit(data);
  if (!result.ok) throw new DomainError("INVALID", Object.values(result.errors)[0], null, result.errors);
  const school = result.value.school !== undefined ? result.value.school : m.school;
  const email = result.value.email !== undefined ? result.value.email : m.email;
  const emailErr = profile.schoolEmailError(school, email);
  if (emailErr) throw new DomainError("INVALID", emailErr, null, { email: emailErr });
  const fields = Object.keys(result.value);
  if (fields.length) {
    db.prepare(`UPDATE members SET ${fields.map((f) => `${f} = @${f}`).join(", ")} WHERE id = @id`).run({ ...result.value, id: m.id });
    auditLog.record({ actor, action: "profile.self_edit", member_id: m.id, object_type: "member", object_id: m.id, detail: fields.join(",") });
  }
  return getProfile(actor, m.id);
}

function changeStatus(actor, id, status, reason) {
  const m = requireRaw(id);
  const restoreTl = m.role === "team_leader" && m.status === "pauza" && status === "activ" && can(actor, "members.restore_team_leader");
  if (!restoreTl) {
    assertCan(actor, "members.manage");
    assertCanTouchRole(actor, m.role); // A5 makes status = rights: pausing the TL would strip them
  }
  if (!VALID_STATUSES.includes(status)) throw new DomainError("INVALID", "Status invalid.");
  if (status !== "activ") assertNotLastTeamLeader(m);
  const active = status === "activ" || status === "pauza" || status === "alumni" ? 1 : 0;
  // Art. 41.8: becoming 'iesit' destroys the medical sheet in the same transaction (files right after the commit).
  // Reactivating later restores nothing - the member uploads a new sheet.
  const files = db.transaction(() => {
    db.prepare("UPDATE members SET status = ?, active = ?, left_at = ? WHERE id = ?")
      .run(status, active, status === "iesit" ? new Date().toISOString() : m.left_at, id);
    db.prepare("INSERT INTO member_status_history (member_id, from_status, to_status, reason, changed_by) VALUES (?, ?, ?, ?, ?)")
      .run(id, m.status, status, reason || null, actor.id);
    return status === "iesit" ? documents.destroyMedicalRows(actor, id) : [];
  })();
  documents.removeFiles(files);
  if (!active) bumpTokenVersion(id);
  return getRaw(id);
}

function setPause(actor, id, pauseUntil, reason) {
  const m = changeStatus(actor, id, "pauza", reason);
  db.prepare("UPDATE members SET pause_until = ? WHERE id = ?").run(pauseUntil || null, id);
  return getRaw(id);
}

function resetPassword(actor, id) {
  assertCan(actor, "members.manage");
  assertCanTouchRole(actor, requireRaw(id).role);
  const password = randomPassword();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE members SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(hash, id);
  bumpTokenVersion(id);
  return { password };
}

// A1: the current password is required, except for the forced change after a temporary password.
function changeOwnPassword(actor, newPassword, currentPassword) {
  const m = requireRaw(actor.id);
  const err = passwordError(newPassword);
  if (err) throw new DomainError("INVALID", err);
  if (!m.must_change_password) {
    if (!currentPassword) throw new DomainError("INVALID", "Introdu parola actuală.");
    if (!m.password_hash || !bcrypt.compareSync(String(currentPassword), m.password_hash)) {
      throw new DomainError("FORBIDDEN", "Parola actuală nu este corectă.");
    }
  }
  if (m.password_hash && bcrypt.compareSync(newPassword, m.password_hash)) {
    throw new DomainError("INVALID", "Parola nouă trebuie să fie diferită de cea actuală.");
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE members SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hash, actor.id);
  bumpTokenVersion(actor.id);
}

// ── Guardians ──────────────────────────────────────────────────────────
function listGuardians(actor, memberId) {
  const m = requireRaw(memberId);
  assertCan(actor, "members.view_contacts", m);
  return db.prepare("SELECT * FROM guardians WHERE member_id = ?").all(memberId);
}

function addGuardian(actor, memberId, data) {
  requireRaw(memberId);
  assertCan(actor, "guardians.manage", { member_id: memberId });
  const { name, relation, phone, email } = data || {};
  if (!name || !name.trim()) throw new DomainError("INVALID", "Numele tutorelui e obligatoriu.");
  const info = db.prepare("INSERT INTO guardians (member_id, name, relation, phone, email) VALUES (?, ?, ?, ?, ?)")
    .run(memberId, name.trim(), relation || null, phone ? normalizePhone(phone) : null, email || null);
  return db.prepare("SELECT * FROM guardians WHERE id = ?").get(info.lastInsertRowid);
}

function updateGuardian(actor, guardianId, data) {
  const g = db.prepare("SELECT * FROM guardians WHERE id = ?").get(guardianId);
  if (!g) throw new DomainError("NOT_FOUND", "Tutore negăsit.");
  assertCan(actor, "guardians.manage", g);
  const { name, relation, phone, email } = data || {};
  db.prepare("UPDATE guardians SET name=COALESCE(?,name), relation=COALESCE(?,relation), phone=COALESCE(?,phone), email=COALESCE(?,email) WHERE id=?")
    .run(name || null, relation || null, phone ? normalizePhone(phone) : null, email || null, guardianId);
  return db.prepare("SELECT * FROM guardians WHERE id = ?").get(guardianId);
}

function removeGuardian(actor, guardianId) {
  const g = db.prepare("SELECT * FROM guardians WHERE id = ?").get(guardianId);
  if (!g) throw new DomainError("NOT_FOUND", "Tutore negăsit.");
  assertCan(actor, "guardians.manage", g);
  db.prepare("DELETE FROM guardians WHERE id = ?").run(guardianId);
}

// ── Import (CSV / vCard) — preview then commit, matched by normalized phone ─────────────
function previewImport(actor, rows) {
  assertCan(actor, "members.manage");
  const existingByPhone = new Map(
    db.prepare("SELECT id, phone, full_name FROM members").all().map((m) => [m.phone, m])
  );
  return rows.map((row) => {
    const digits = row.phone ? normalizePhone(row.phone) : null;
    const existing = digits ? existingByPhone.get(digits) : null;
    return {
      name: row.name || null,
      phone: digits,
      email: row.email || null,
      action: !digits ? "skip_invalid_phone" : existing ? "update" : "create",
      existing_id: existing ? existing.id : null,
    };
  });
}

function commitImport(actor, rows) {
  assertCan(actor, "members.manage");
  const preview = previewImport(actor, rows);
  const results = [];
  for (const row of preview) {
    if (row.action === "skip_invalid_phone") { results.push(row); continue; }
    if (row.action === "create") {
      const created = create(actor, { name: row.name || row.phone, phone: row.phone, email: row.email, role: "volunteer" });
      // Shown once to the leader who imported (A1) - never stored in clear.
      results.push({ ...row, id: created.id, username: created.username, password: created.password });
    } else {
      update(actor, row.existing_id, { name: row.name || undefined, email: row.email || undefined });
      results.push({ ...row, id: row.existing_id });
    }
  }
  return results;
}

function missingOf(m) {
  const hasGuardian = !!db.prepare("SELECT 1 FROM guardians WHERE member_id = ?").get(m.id);
  return profile.missingFields(m, hasGuardian);
}

// LEADERS: members with incomplete profile data (design-formular-date.md §3) - same
// profile.missingFields() used by the AI tool and the Acasă/Membri badges.
function missingDataList(actor) {
  assertCan(actor, "members.manage");
  const rows = db.prepare("SELECT * FROM members WHERE status != 'iesit'").all();
  return rows
    .map((m) => ({ id: m.id, name: m.full_name, phone: hasPhone(m) ? m.phone : null, missing: missingOf(m) }))
    .filter((r) => r.missing.length);
}

// The writer's own missing profile fields (AI tool datele_mele_lipsa, command "date").
function myMissingFields(actor) {
  return missingOf(requireRaw(actor.id));
}

module.exports = {
  authenticate,
  adminList,
  hasPhone,
  whatsappPhone,
  assertCanEditAccount,
  missingDataList,
  myMissingFields,
  getRaw,
  requireRaw,
  listDirectory,
  getProfile,
  updateOwn,
  create,
  update,
  changeStatus,
  setPause,
  resetPassword,
  changeOwnPassword,
  bumpTokenVersion,
  listGuardians,
  addGuardian,
  updateGuardian,
  removeGuardian,
  previewImport,
  commitImport,
};
