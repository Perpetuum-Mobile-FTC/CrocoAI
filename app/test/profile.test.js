// domain/profile.js - the single profile validation used by public forms, Admin and the AI agent
// (design-formular-date.md §1). No DB access here.
const { test } = require("node:test");
const assert = require("node:assert");
const profile = require("../src/domain/profile");

const adultInput = {
  full_name: "Ion Popescu",
  phone: "0722111222",
  email: "ion@exemplu.ro",
  birthdate: "15.03.2005", // > 18 at test time
  class: "a XII-a A",
  school: "Liceul Testului",
  department: "tehnic",
};

const minorInput = {
  ...adultInput,
  full_name: "Maria Ionescu",
  phone: "0722111223",
  email: "maria@exemplu.ro",
  birthdate: "15.03.2012", // minor
};

test("validateProfile: adult, mode=public, requires motivation + gdpr_ack but no guardian", () => {
  const r = profile.validateProfile({ ...adultInput, motivation: "Vreau să învăț robotică.", gdpr_ack: true }, { mode: "public" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.is_minor, false);
  assert.equal(r.value.phone, "40722111222");
  assert.equal(r.value.birthdate, "2005-03-15");
});

test("validateProfile: minor, mode=public, requires guardian_* + guardian_ack", () => {
  const withoutGuardian = profile.validateProfile({ ...minorInput, motivation: "Vreau să intru în echipă.", gdpr_ack: true }, { mode: "public" });
  assert.equal(withoutGuardian.ok, false);
  assert.ok(withoutGuardian.errors.guardian_name);
  assert.ok(withoutGuardian.errors.guardian_relation);
  assert.ok(withoutGuardian.errors.guardian_phone);
  assert.ok(withoutGuardian.errors.guardian_ack);

  const withGuardian = profile.validateProfile({
    ...minorInput,
    motivation: "Vreau să intru în echipă.",
    gdpr_ack: true,
    guardian_name: "Elena Ionescu",
    guardian_relation: "mama",
    guardian_phone: "0722111224",
    guardian_ack: true,
  }, { mode: "public" });
  assert.equal(withGuardian.ok, true, JSON.stringify(withGuardian.errors));
  assert.equal(withGuardian.value.is_minor, true);
  assert.equal(withGuardian.value.guardian_phone, "40722111224");
});

test("validateProfile: bad email, bad birthdate, missing department all reported together", () => {
  const r = profile.validateProfile({ ...adultInput, email: "not-an-email", birthdate: "not-a-date", department: "marketing", motivation: "x", gdpr_ack: true }, { mode: "public" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.email);
  assert.ok(r.errors.birthdate);
  assert.ok(r.errors.department);
});

test("validateProfile: phone normalization + duplicate detection is the caller's job (just normalizes here)", () => {
  const r1 = profile.validateProfile({ ...adultInput, phone: "+40722111222", motivation: "x", gdpr_ack: true }, { mode: "public" });
  const r2 = profile.validateProfile({ ...adultInput, phone: "0040722111222", motivation: "x", gdpr_ack: true }, { mode: "public" });
  assert.equal(r1.value.phone, "40722111222");
  assert.equal(r2.value.phone, "40722111222");
});

test("validateProfile: mode=admin skips consents and motivation entirely", () => {
  const r = profile.validateProfile(adultInput, { mode: "admin" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.motivation, undefined);
  assert.equal(r.value.gdpr_ack, undefined);
});

test("validateProfile: mode=completion requires gdpr_ack but not motivation", () => {
  const withoutAck = profile.validateProfile(adultInput, { mode: "completion" });
  assert.equal(withoutAck.ok, false);
  assert.ok(withoutAck.errors.gdpr_ack);
  assert.equal(withoutAck.errors.motivation, undefined);

  const withAck = profile.validateProfile({ ...adultInput, gdpr_ack: true }, { mode: "completion" });
  assert.equal(withAck.ok, true, JSON.stringify(withAck.errors));
});

test("missingFields: all core fields missing on a bare member", () => {
  const missing = profile.missingFields({ id: 1 }, true);
  assert.ok(missing.includes("email"));
  assert.ok(missing.includes("birthdate"));
  assert.ok(missing.includes("class"));
  assert.ok(missing.includes("school"));
});

test("missingFields: minor member without a guardian on file flags 'guardian'", () => {
  const member = { email: "a@b.ro", birthdate: "2012-01-01", class: "a 8-a", school: "Scoala" };
  assert.ok(profile.missingFields(member, false).includes("guardian"));
  assert.ok(!profile.missingFields(member, true).includes("guardian"));
});

test("missingFields: complete adult profile -> []", () => {
  const member = { email: "a@b.ro", birthdate: "2000-01-01", class: "a 12-a", school: "Scoala" };
  assert.deepEqual(profile.missingFields(member, true), []);
});
