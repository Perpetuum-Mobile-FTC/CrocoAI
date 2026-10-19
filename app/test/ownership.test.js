const { test } = require("node:test");
const assert = require("node:assert");
const { decideOwnership } = require("../src/services/wa-ownership");

const OWNER = "40712345678";

test("group message: always handled, reply only if mentioned (and only to an active member - A4)", () => {
  const member = { status: "activ" };
  const r1 = decideOwnership({ isGroup: true, mentioned: false, quotedFromMe: false, text: "salut", member });
  assert.equal(r1.handled, true);
  assert.equal(r1.shouldReply, false);

  const r2 = decideOwnership({ isGroup: true, mentioned: true, quotedFromMe: false, text: "@crocoai salut", member });
  assert.equal(r2.handled, true);
  assert.equal(r2.shouldReply, true);

  const r3 = decideOwnership({ isGroup: true, mentioned: false, quotedFromMe: true, text: "raspuns", member });
  assert.equal(r3.shouldReply, true);
});

test("owner private message without 'croco' prefix: not handled (goes to LUCID)", () => {
  const r = decideOwnership({ from: OWNER, text: "ce mai faci", isGroup: false, ownerPhone: OWNER });
  assert.equal(r.handled, false);
});

test("owner private message with 'croco' prefix: handled, prefix stripped", () => {
  const r = decideOwnership({ from: OWNER, text: "croco, ce sarcini am azi?", isGroup: false, ownerPhone: OWNER });
  assert.equal(r.handled, true);
  assert.equal(r.shouldReply, true);
  assert.equal(r.text, "ce sarcini am azi?");
});

test("owner private message with '@crocoai' prefix variant", () => {
  const r = decideOwnership({ from: OWNER, text: "Croco: salut", isGroup: false, ownerPhone: OWNER });
  assert.equal(r.handled, true);
  assert.equal(r.text, "salut");
});

test("active member private message: handled", () => {
  const r = decideOwnership({ from: "40711111111", text: "salut", isGroup: false, ownerPhone: OWNER, member: { status: "activ", onboarding_step: 0 } });
  assert.equal(r.handled, true);
  assert.equal(r.shouldReply, true);
});

test("member mid-onboarding: handled even if not yet active", () => {
  const r = decideOwnership({ from: "40722222222", text: "salut", isGroup: false, ownerPhone: OWNER, member: { status: "iesit", onboarding_step: 2 } });
  assert.equal(r.handled, true);
});

test("stranger private message: not handled", () => {
  const r = decideOwnership({ from: "40799999999", text: "salut", isGroup: false, ownerPhone: OWNER, member: null });
  assert.equal(r.handled, false);
});

test("owner prefix variants are stripped cleanly", () => {
  const { decideOwnership } = require("../src/services/wa-ownership");
  const base = { from: "40712345678", ownerPhone: "40712345678", isGroup: false };
  for (const t of ["croco ce taskuri am?", "crocoai, ce taskuri am?", "@CrocoAI ce taskuri am?", "Croco: ce taskuri am?"]) {
    const d = decideOwnership({ ...base, text: t });
    assert.equal(d.handled, true, t);
    assert.equal(d.text, "ce taskuri am?", t);
  }
  assert.equal(decideOwnership({ ...base, text: "crocodilul e verde" }).handled, false);
});
