// Onboarding (Art. 14, 43) - deterministic dialog, no LLM. wa-gateway is mocked, no network.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "._onboarding_test.db");
process.env.DB_PATH = DB_FILE;
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const db = require("../src/db");
const gateway = require("../src/services/wa-gateway");
const onboarding = require("../src/services/onboarding");
const documentsSvc = require("../src/services/documents");
const { DomainError } = require("../src/domain/errors");

let tl, headTech, buddy;
const sent = []; // { to, text }
const groupCalls = [];

function resetMocks() {
  sent.length = 0;
  groupCalls.length = 0;
  gateway.sendWhatsApp = async (to, text) => { sent.push({ to, text }); return true; };
  gateway.groupParticipants = async (args) => { groupCalls.push(args); return { ok: true, code: 200 }; };
  gateway.groupInvite = async () => null;
}

before(() => {
  const insert = db.prepare("INSERT INTO members (full_name, phone, role, auth_role, status) VALUES (?, ?, ?, ?, 'activ')");
  tl = { id: insert.run("Team Leader", "40700001001", "team_leader", "team_leader").lastInsertRowid, role: "team_leader", status: "activ" };
  headTech = insert.run("Sef Tehnic", "40700001002", "head_tech", "head_tech").lastInsertRowid;
  buddy = insert.run("Buddy Vechi", "40700001003", "member", "member").lastInsertRowid;
});

beforeEach(resetMocks);

after(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  const backupDir = path.join(__dirname, "backups");
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  delete process.env.DB_PATH;
});

function member(role) {
  return { id: role === "manager" ? headTech : tl.id, role: role === "manager" ? "head_tech" : "team_leader", status: "activ" };
}

test("onboarding.start is LEADERS only (onboarding.start)", () => {
  const plainMember = { id: 999, role: "member", status: "activ" };
  assert.throws(() => onboarding.start(plainMember, { name: "X", phone: "40711111111" }), DomainError);
});

test("full dialog happy path: start -> all steps -> completion side effects", async () => {
  const { member: created, onboarding: ob } = onboarding.start(tl, { name: "Voluntar Nou", phone: "40722222201", department: "tehnic", buddy_id: buddy });
  assert.equal(created.role, "volunteer");
  assert.equal(created.onboarding_step, 1);
  assert.ok(sent.some((s) => s.to === "40722222201" && /Bun venit/.test(s.text)));
  assert.ok(sent.some((s) => s.to === "40700001003" && /buddy/i.test(s.text))); // buddy notified

  let m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  let reply;

  reply = await onboarding.handleReply(m, "Ion Popescu");
  assert.match(reply, /clasă/);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  assert.equal(m.onboarding_step, 2);

  reply = await onboarding.handleReply(m, "a X-a");
  assert.match(reply, /școală/);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);

  reply = await onboarding.handleReply(m, "Liceul Testului");
  assert.match(reply, /email/);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);

  // invalid email -> stays on the same step with an error
  reply = await onboarding.handleReply(m, "not-an-email");
  assert.match(reply, /nu pare validă/);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  assert.equal(m.onboarding_step, 4);

  reply = await onboarding.handleReply(m, "ion.popescu@exemplu.ro");
  assert.match(reply, /data nașterii/i);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);

  // invalid date format
  reply = await onboarding.handleReply(m, "2010-03-15");
  assert.match(reply, /format/);

  reply = await onboarding.handleReply(m, "15.03.2010");
  assert.match(reply, /departament/i);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);

  // invalid department
  reply = await onboarding.handleReply(m, "marketing");
  assert.match(reply, /tehnic, non-tehnic sau ambele/);

  reply = await onboarding.handleReply(m, "tehnic");
  assert.match(reply, /confirmă datele/i);
  assert.match(reply, /Ion Popescu/);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  assert.equal(m.onboarding_step, 7);

  // correction flow: "corectez email" goes back to step 4 and re-asks
  reply = await onboarding.handleReply(m, "corectez email");
  assert.match(reply, /adresa ta de email/i);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  assert.equal(m.onboarding_step, 4);
  reply = await onboarding.handleReply(m, "ion.popescu.corect@exemplu.ro");
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  // re-advances through data/departament again to confirmare
  reply = await onboarding.handleReply(m, "15.03.2010");
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  reply = await onboarding.handleReply(m, "tehnic");
  assert.match(reply, /ion\.popescu\.corect@exemplu\.ro/);
  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);

  reply = await onboarding.handleReply(m, "DA");
  assert.match(reply, /cont.*activ/i);

  m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  assert.equal(m.onboarding_step, 0);
  assert.equal(m.full_name, "Ion Popescu");
  assert.equal(m.email, "ion.popescu.corect@exemplu.ro");
  assert.equal(m.birthdate, "2010-03-15");
  assert.equal(m.must_change_password, 1);

  // Credentials + documents list sent.
  const credMsg = sent.find((s) => s.to === "40722222201" && /Username/.test(s.text));
  assert.ok(credMsg);
  assert.match(credMsg.text, /Parolă temporară/);

  // Department head + buddy notified of completion.
  const heads = db.prepare("SELECT * FROM notifications WHERE member_id = ? AND type = 'onboarding_completed'").all(headTech);
  assert.equal(heads.length, 1);
  const buddyNotifs = db.prepare("SELECT * FROM notifications WHERE member_id = ? AND type = 'onboarding_completed'").all(buddy);
  assert.equal(buddyNotifs.length, 1);

  const detail = onboarding.detail(tl, created.id);
  assert.equal(detail.status, "complet");
  const byKey = Object.fromEntries(detail.checklist.map((c) => [c.step_key, c.done]));
  assert.equal(byKey.buddy, true);
  assert.equal(byKey.platforma, true);
});

test("group add success ticks grup_whatsapp; privacy refusal falls back to invite link then LEADERS notification", async () => {
  db.prepare("INSERT INTO wa_groups (group_id, name, tracked) VALUES ('g1@g.us', 'Grup Oficial', 1)").run();

  const { member: created } = onboarding.start(tl, { name: "Alt Voluntar", phone: "40722222202" });
  let m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  for (const input of ["Alt Voluntar", "a 9-a", "Scoala", "alt@exemplu.ro", "01.01.2011", "ambele"]) {
    await onboarding.handleReply(m, input);
    m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  }
  await onboarding.handleReply(m, "DA");
  let detail = onboarding.detail(tl, created.id);
  assert.equal(Object.fromEntries(detail.checklist.map((c) => [c.step_key, c.done])).grup_whatsapp, true);

  // Now simulate a privacy refusal with no gateway invite and no stored invite_link -> LEADERS notified.
  gateway.groupParticipants = async () => ({ ok: false, code: 403, message: "AddParticipantsError: You have no admin rights" });
  gateway.groupInvite = async () => null;
  const { member: created2 } = onboarding.start(tl, { name: "Al Treilea", phone: "40722222203" });
  let m2 = db.prepare("SELECT * FROM members WHERE id = ?").get(created2.id);
  for (const input of ["Al Treilea", "a 9-a", "Scoala", "al3@exemplu.ro", "01.01.2011", "ambele"]) {
    await onboarding.handleReply(m2, input);
    m2 = db.prepare("SELECT * FROM members WHERE id = ?").get(created2.id);
  }
  await onboarding.handleReply(m2, "DA");
  detail = onboarding.detail(tl, created2.id);
  assert.equal(Object.fromEntries(detail.checklist.map((c) => [c.step_key, c.done])).grup_whatsapp, false);
  const leaderNotifs = db.prepare("SELECT * FROM notifications WHERE member_id = ? AND type = 'onboarding_group_manual'").all(tl.id);
  assert.ok(leaderNotifs.length >= 1);

  // With a stored invite_link, the member gets a WA message instead of a leader notification.
  db.prepare("UPDATE wa_groups SET invite_link = 'https://chat.whatsapp.com/abc123' WHERE group_id = 'g1@g.us'").run();
  const { member: created3 } = onboarding.start(tl, { name: "Al Patrulea", phone: "40722222204" });
  let m3 = db.prepare("SELECT * FROM members WHERE id = ?").get(created3.id);
  for (const input of ["Al Patrulea", "a 9-a", "Scoala", "al4@exemplu.ro", "01.01.2011", "ambele"]) {
    await onboarding.handleReply(m3, input);
    m3 = db.prepare("SELECT * FROM members WHERE id = ?").get(created3.id);
  }
  const beforeLeaderNotifCount = db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'onboarding_group_manual'").get(tl.id).c;
  await onboarding.handleReply(m3, "DA");
  const afterLeaderNotifCount = db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'onboarding_group_manual'").get(tl.id).c;
  assert.equal(afterLeaderNotifCount, beforeLeaderNotifCount); // no new leader notification
  assert.ok(sent.some((s) => s.to === "40722222204" && /chat\.whatsapp\.com\/abc123/.test(s.text)));
});

test("required documents list is sent at completion", async () => {
  const { member: created } = onboarding.start(tl, { name: "Documente Test", phone: "40722222205" });
  let m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  for (const input of ["Documente Test", "a 9-a", "Scoala", "doc@exemplu.ro", "01.01.2011", "ambele"]) {
    await onboarding.handleReply(m, input);
    m = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  }
  await onboarding.handleReply(m, "DA");
  const fresh = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  const required = documentsSvc.requiredFor(fresh);
  const credMsg = sent.find((s) => s.to === "40722222205" && /Username/.test(s.text));
  assert.ok(credMsg);
  for (const doc of required) assert.match(credMsg.text, new RegExp(doc.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("checklist tick/untick (MANAGERS only) and 30-day overdue signal", () => {
  const { member: created, onboarding: ob } = onboarding.start(tl, { name: "Checklist Test", phone: "40722222206" });
  const plainMember = { id: 999, role: "member", status: "activ" };
  assert.throws(() => onboarding.setTick(plainMember, created.id, "prezentare", true), DomainError);

  onboarding.setTick(tl, created.id, "prezentare", true);
  let detail = onboarding.detail(tl, created.id);
  assert.equal(detail.checklist.find((c) => c.step_key === "prezentare").done, true);
  onboarding.setTick(tl, created.id, "prezentare", false);
  detail = onboarding.detail(tl, created.id);
  assert.equal(detail.checklist.find((c) => c.step_key === "prezentare").done, false);

  // Backdate started_at past the 30-day threshold to simulate an overdue signal (Art. 43.3).
  db.prepare("UPDATE onboarding SET started_at = datetime('now', '-40 days') WHERE id = ?").run(ob.id);
  const overdue = onboarding.overdueSignals(tl);
  assert.ok(overdue.some((o) => o.member_id === created.id));

  assert.throws(() => onboarding.overdueSignals({ id: 999, role: "member", status: "activ" }), DomainError);
});

test("restart cancels the previous process and starts fresh; cancel marks it anulat", () => {
  const { member: created } = onboarding.start(tl, { name: "Restart Test", phone: "40722222207" });
  onboarding.restart(tl, created.id);
  const fresh = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  assert.equal(fresh.onboarding_step, 1);
  const rows = db.prepare("SELECT * FROM onboarding WHERE member_id = ? ORDER BY id").all(created.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "anulat");
  assert.equal(rows[1].status, "activ");

  onboarding.cancel(tl, created.id);
  const cancelled = db.prepare("SELECT * FROM members WHERE id = ?").get(created.id);
  assert.equal(cancelled.onboarding_step, 0);
});

test("handleReply with no active onboarding returns a safe message instead of throwing", async () => {
  const notOnboarding = { id: tl.id, onboarding_step: 0 };
  const reply = await onboarding.handleReply(notOnboarding, "orice");
  assert.match(reply, /Nu ai un proces de integrare activ/);
});

test("document approval auto-ticks the 'documente' checklist item once all required docs are approved", () => {
  const { member: created, onboarding: ob } = onboarding.start(tl, { name: "Documente Auto", phone: "40722222208" });
  const required = documentsSvc.requiredFor(db.prepare("SELECT * FROM members WHERE id = ?").get(created.id));
  if (!required.length) return; // nothing to approve in this fixture, skip gracefully
  for (const doc of required) {
    const buffer = Buffer.from("%PDF-1.4 fake");
    const uploaded = documentsSvc.upload({ id: created.id }, created.id, doc.key, { buffer, size: buffer.length, mimetype: "application/pdf", originalname: "x.pdf" });
    documentsSvc.review(tl, uploaded.id, "aprobat");
  }
  const detail = onboarding.detail(tl, created.id);
  assert.equal(detail.checklist.find((c) => c.step_key === "documente").done, true);
});
