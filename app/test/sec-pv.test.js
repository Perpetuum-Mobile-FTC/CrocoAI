// Security package A2 (docs/design-securitate-2026-10.md): PV draft schema, escaped export with a strict
// CSP, and a global script-src without 'unsafe-inline' (no inline scripts in the public pages).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("sec_pv");
const { server } = require("../server");
const db = require("../src/db");
const attendanceSvc = require("../src/services/attendance");
const meetings = require("../src/services/meetings");
const { DomainError } = require("../src/domain/errors");

let BASE, M, meeting;
const XSS = `<img src=x onerror="alert(1)">`;

function validDraft(over = {}) {
  return {
    session_date: "2026-09-08", start_time: "18:00", location: "Sala S03", agenda: ["Robot"],
    attendance: { total_present: 3, total_roster: 10, present_names: ["Ana"], absent_motivated_names: [], absent_names: ["Ion"] },
    discussions: [{ point: "Robot", discussion: "Brațul", decision: "Continuăm", majora: false }],
    announcements: "Nimic", actions: [{ action: "CAD", responsible_name: "Ana", responsible_member_id: null, due_date: "2026-09-15" }],
    next_meeting: { date: null, note: "" }, redactat_de: null, verificat_de: null, ...over,
  };
}

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [{ key: "tl", role: "team_leader" }, { key: "mem", role: "member" }]);
  const session = attendanceSvc.createSession(M.tl, { date: "2026-09-08", start_time: "18:00", type: "sedinta", title: "Ședința" });
  meeting = meetings.getOrCreateForSession(M.tl, session.id);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

test("A2: updateDraft validates the schema (numbers for attendance, strings/arrays elsewhere)", () => {
  const bad = [
    validDraft({ attendance: { ...validDraft().attendance, total_present: XSS } }),
    validDraft({ attendance: { ...validDraft().attendance, total_roster: "10" } }),
    validDraft({ discussions: "nu e listă" }),
    validDraft({ discussions: [{ point: { html: XSS }, discussion: "", decision: "", majora: false }] }),
    validDraft({ agenda: [1, 2] }),
    validDraft({ actions: [{ action: ["x"] }] }),
    validDraft({ announcements: 42 }),
    validDraft({ next_meeting: "mâine" }),
  ];
  for (const d of bad) {
    assert.throws(() => meetings.updateDraft(M.tl, meeting.id, d), (e) => e instanceof DomainError && e.code === "INVALID", JSON.stringify(d).slice(0, 120));
  }
  const ok = meetings.updateDraft(M.tl, meeting.id, validDraft({ extra_field: "ignorat", verificat_de: "Fals" }));
  assert.equal(ok.draft.attendance.total_present, 3);
  assert.equal(ok.draft.extra_field, undefined); // unknown keys dropped
  assert.equal(ok.draft.verificat_de, null); // set only by approval, never by an edit
});

test("A2: export escapes every field and is served with script-src 'none'", async () => {
  // A legacy row stored before validation existed may still hold anything: the export must stay inert.
  const evil = validDraft({ location: XSS, announcements: XSS, agenda: [XSS] });
  evil.attendance.total_present = XSS;
  evil.attendance.total_roster = XSS;
  evil.discussions[0].point = XSS;
  evil.actions[0].action = XSS;
  db.prepare("UPDATE meetings SET draft = ? WHERE id = ?").run(JSON.stringify(evil), meeting.id);
  const html = meetings.exportHtml(M.tl, meeting.id);
  assert.ok(!html.includes("<img"), "raw tag in export");
  assert.ok(html.includes("&lt;img"));

  const cookie = await login(BASE, M.tl.phone);
  const r = await fetch(`${BASE}/api/meetings/${meeting.id}/export`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /default-src 'none'/);
});

test("A2: global CSP has no 'unsafe-inline' in script-src", async () => {
  const r = await fetch(`${BASE}/login`);
  const csp = r.headers.get("content-security-policy");
  const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"));
  assert.ok(scriptSrc, csp);
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), scriptSrc);
  assert.ok(!/script-src-attr\s+'unsafe-inline'/.test(csp), csp);
});

test("A2: public HTML pages have no inline scripts or inline event handlers", () => {
  const dir = path.join(__dirname, "..", "public");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(dir, f), "utf8");
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1]));
    assert.equal(inline.length, 0, `${f} has an inline <script>`);
    assert.ok(!/\son[a-z]+\s*=/.test(html), `${f} has an inline event handler`);
  }
});
