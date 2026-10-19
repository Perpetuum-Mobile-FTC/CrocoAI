// Unit tests for the monthly FTC Competition Manual update check (docs/design-ai-hardening.md §2
// update). No network, no real model: global.fetch, wa-gateway.sendWhatsApp, announcements.publishSystem
// and the isolated AI announcement call are all mocked.
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DB_FILE = path.join(os.tmpdir(), `crocoai-ftc-updater-${process.pid}.db`);
const DOCS_DIR = path.join(os.tmpdir(), `crocoai-ftc-updater-docs-${process.pid}`);
process.env.DB_PATH = DB_FILE;
process.env.FTC_DOCS_DIR = DOCS_DIR;
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const db = require("../src/db");
const ftcDocs = require("../src/services/ftc-docs");
const ftcPdf = require("../src/services/ftc-pdf-extract");
const announcementsSvc = require("../src/services/announcements");
const waGateway = require("../src/services/wa-gateway");
const notifications = require("../src/services/notifications");
const updater = require("../src/services/ftc-manual-updater");

const leader = { id: 1, role: "team_leader", status: "activ" };
const member = { id: 2, role: "member", status: "activ" };

const originalFetch = global.fetch;

function metaPath() { return path.join(DOCS_DIR, "meta.json"); }
function manualFilePath() { return path.join(DOCS_DIR, "competition-manual.md"); }

function writeExistingVersion({ version = "TU02", markdown }) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(manualFilePath(), markdown);
  fs.writeFileSync(metaPath(), JSON.stringify({
    source_url: "https://ftc-resources.firstinspires.org/ftc/game/manual",
    filename: `BIOBUZZ_Competition_Manual_${version}.pdf`,
    version, season: "BIOBUZZ", etag: "old-etag", sha256: "old-sha", fetched_at: "2026-09-01T00:00:00.000Z",
  }, null, 2));
}

before(() => {
  // phone_verified_at: the fallback DM goes only to verified phones (A3, pachet B).
  db.prepare("INSERT INTO members (full_name, phone, role, status, username, password_hash, phone_verified_at) VALUES (?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00Z')")
    .run("Team Leader Test", "40700000001", "team_leader", "activ", "tl-ftc-test", "x");
});

beforeEach(() => {
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
  ftcDocs.invalidateCache();
  db.prepare("DELETE FROM ftc_manual_versions").run();
  db.prepare("DELETE FROM notifications").run();
  delete process.env.TEAM_GROUP_ID;
  require("./_ai-env").clearAiProviderEnv();
  global.fetch = originalFetch;
  announcementsSvc.publishSystem = () => null;
  waGateway.sendWhatsApp = async () => true;
  ftcPdf.extractPdfText = () => "";
});

after(() => {
  global.fetch = originalFetch;
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.FTC_DOCS_DIR;
});

function pdfResponse({ etag = "new-etag", filename = "BIOBUZZ_Competition_Manual_TU03.pdf", buffer = Buffer.from("fake-pdf-bytes") } = {}) {
  return {
    status: 200,
    ok: true,
    headers: {
      get: (name) => {
        const n = name.toLowerCase();
        if (n === "content-type") return "application/pdf";
        if (n === "etag") return etag;
        if (n === "last-modified") return "Thu, 01 Oct 2026 00:00:00 GMT";
        if (n === "content-disposition") return `inline; filename="${filename}"`;
        if (n === "content-length") return String(buffer.length);
        return null;
      },
    },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

test("unchanged etag -> 304, no download/extraction/post", async () => {
  writeExistingVersion({ version: "TU02", markdown: "**G101 — Title**\nBody." });
  let fetchCalls = 0;
  global.fetch = async (url, opts) => {
    fetchCalls++;
    assert.equal(opts.headers["If-None-Match"], "old-etag");
    return { status: 304 };
  };
  let posted = false;
  announcementsSvc.publishSystem = () => { posted = true; return null; };

  const result = await updater.checkForUpdate({});
  assert.equal(fetchCalls, 1);
  assert.equal(result.changed, false);
  assert.equal(posted, false);
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8"));
  assert.equal(meta.last_check_result, "unchanged");
});

test("first-ever import never announces", async () => {
  // no writeExistingVersion() call -> RUNTIME_DIR starts empty (no meta.json)
  ftcPdf.extractPdfText = () => "R101 *New rule title. Some body text.";
  global.fetch = async () => pdfResponse({ filename: "BIOBUZZ_Competition_Manual_TU03.pdf" });
  let posted = false;
  announcementsSvc.publishSystem = () => { posted = true; return null; };
  let waSent = false;
  waGateway.sendWhatsApp = async () => { waSent = true; return true; };

  const result = await updater.checkForUpdate({});
  assert.equal(result.changed, true);
  assert.equal(result.firstImport, true);
  assert.equal(posted, false);
  assert.equal(waSent, false);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM ftc_manual_versions").get().c, 0);
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8"));
  assert.equal(meta.version, "TU03");
  assert.equal(meta.last_check_result, "seed");
});

test("changed version -> diff (added/removed/changed), whitespace-only ignored, one version row, identical announcement in Anunțuri + WhatsApp", async () => {
  writeExistingVersion({
    version: "TU02",
    markdown: [
      "**G101 — Old stable rule**",
      "Old stable rule. This rule never changes, just reformatted whitespace.",
      "",
      "**R101 — Removed rule**",
      "This rule disappears in the new version.",
      "",
      "**R102 — Changed rule**",
      "Old wording of this rule.",
    ].join("\n"),
  });
  // pdftotext dump feeding the "rules" parser for the NEW version: G101 unchanged (just rewrapped
  // across lines -> whitespace-only diff), R101 dropped, R102 reworded, A201 brand new.
  ftcPdf.extractPdfText = () => [
    "G101 *Old stable rule. This rule never changes,",
    "just reformatted whitespace.",
    "R102 *Changed rule. New wording of this rule, now different.",
    "A201 *Brand new rule. Added in TU03.",
  ].join("\n");
  global.fetch = async () => pdfResponse({ filename: "BIOBUZZ_Competition_Manual_TU03.pdf" });

  let postedText = null;
  announcementsSvc.publishSystem = (title, body) => { postedText = body ? `${title}\n${body}` : title; return null; };
  let waText = null;
  process.env.TEAM_GROUP_ID = "team-group@g.us";
  waGateway.sendWhatsApp = async (to, text) => { if (to === "team-group@g.us") waText = text; return true; };

  const result = await updater.checkForUpdate({});
  assert.equal(result.changed, true);
  assert.equal(result.version, "TU03");
  assert.deepEqual(result.added.map((a) => a.code), ["A201"]);
  assert.deepEqual(result.removed.map((r) => r.code), ["R101"]);
  assert.deepEqual(result.changed_rules.map((c) => c.code), ["R102"]);

  const row = db.prepare("SELECT * FROM ftc_manual_versions ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.version, "TU03");
  assert.ok(JSON.parse(row.added).some((a) => a.code === "A201"));

  assert.ok(postedText, "should have posted to Anunțuri");
  assert.equal(postedText, waText, "WhatsApp message must be identical to the Anunțuri post");
  assert.match(postedText, /BIOBUZZ/);
  assert.match(postedText, /TU02.*TU03|TU03/);

  // Previous version's parsed copy kept.
  assert.ok(fs.existsSync(path.join(DOCS_DIR, "previous", "TU02.md")));
});

test("TEAM_GROUP_ID unset -> falls back to team_leader WhatsApp + platform notifications", async () => {
  writeExistingVersion({ version: "TU02", markdown: "**G101 — Title**\nOld body." });
  ftcPdf.extractPdfText = () => "G101 *Title. New body, different from before.";
  global.fetch = async () => pdfResponse({ filename: "BIOBUZZ_Competition_Manual_TU03.pdf" });
  delete process.env.TEAM_GROUP_ID;
  const waCalls = [];
  waGateway.sendWhatsApp = async (to, text) => { waCalls.push({ to, text }); return true; };

  await updater.checkForUpdate({});
  assert.ok(waCalls.some((c) => c.to === "40700000001" && /Nu am putut posta/.test(c.text)));
  const notif = db.prepare("SELECT * FROM notifications WHERE member_id = ? AND type = 'ftc_manual_update'").get(leader.id);
  assert.ok(notif);
});

test("TEAM_GROUP_ID set but send fails -> falls back to team_leader + notifications", async () => {
  writeExistingVersion({ version: "TU02", markdown: "**G101 — Title**\nOld body." });
  ftcPdf.extractPdfText = () => "G101 *Title. New body, different from before.";
  global.fetch = async () => pdfResponse({ filename: "BIOBUZZ_Competition_Manual_TU03.pdf" });
  process.env.TEAM_GROUP_ID = "team-group@g.us";
  const waCalls = [];
  waGateway.sendWhatsApp = async (to, text) => {
    waCalls.push({ to, text });
    return to !== "team-group@g.us"; // group send fails, leader send succeeds
  };

  await updater.checkForUpdate({});
  assert.ok(waCalls.some((c) => c.to === "team-group@g.us"));
  assert.ok(waCalls.some((c) => c.to === "40700000001" && /Nu am putut posta/.test(c.text)));
});

test("AI announcement failure -> falls back to deterministic message", async () => {
  writeExistingVersion({ version: "TU02", markdown: "**G101 — Title**\nOld body." });
  ftcPdf.extractPdfText = () => "G101 *Title. New body, quite different now.";
  global.fetch = async () => pdfResponse({ filename: "BIOBUZZ_Competition_Manual_TU03.pdf" });
  process.env.ANTHROPIC_API_KEY = "test-key";
  updater.generateAnnouncementText = async () => { throw new Error("model unavailable"); };

  let postedText = null;
  announcementsSvc.publishSystem = (title, body) => { postedText = body ? `${title}\n${body}` : title; return null; };
  await updater.checkForUpdate({});
  assert.ok(postedText);
  assert.match(postedText, /Reguli modificate: G101/);
});

test("AI announcement success is used verbatim (within length cap)", async () => {
  writeExistingVersion({ version: "TU02", markdown: "**G101 — Title**\nOld body." });
  ftcPdf.extractPdfText = () => "G101 *Title. New body, quite different now.";
  global.fetch = async () => pdfResponse({ filename: "BIOBUZZ_Competition_Manual_TU03.pdf" });
  process.env.ANTHROPIC_API_KEY = "test-key";
  updater.generateAnnouncementText = async () => ({ text: "- G101 a fost reformulată.", usage: { input_tokens: 10, output_tokens: 5 }, cost: 0.0001, model: "claude-haiku-4-5" });

  let postedText = null;
  announcementsSvc.publishSystem = (title, body) => { postedText = body ? `${title}\n${body}` : title; return null; };
  await updater.checkForUpdate({});
  assert.match(postedText, /G101 a fost reformulată/);
});

test("monthlyTickDue: only true on the 1st at/after 10:00 Europe/Bucharest, and only once per month", () => {
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
  const notFirst = new Date(Date.UTC(2026, 9, 15, 10, 0, 0)); // Oct 15
  assert.equal(updater.monthlyTickDue(notFirst), false);

  const tooEarly = new Date(Date.UTC(2026, 10, 1, 6, 0, 0)); // Nov 1, 08:00 Bucharest (UTC+2) - before 10:00
  assert.equal(updater.monthlyTickDue(tooEarly), false);

  const dueNow = new Date(Date.UTC(2026, 10, 1, 8, 0, 0)); // Nov 1, 10:00 Bucharest
  assert.equal(updater.monthlyTickDue(dueNow), true);

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, "scheduler-state.json"), JSON.stringify({ last_monthly_run: "2026-11" }));
  assert.equal(updater.monthlyTickDue(dueNow), false);
});

test("checkForUpdate is LEADERS only when called with an actor (force-check route)", async () => {
  await assert.rejects(() => updater.checkForUpdate({ actor: member, force: true }), { code: "FORBIDDEN" });
});

test("getStatus is LEADERS only and reports current meta + history", async () => {
  writeExistingVersion({ version: "TU02", markdown: "**G101 — Title**\nBody." });
  assert.throws(() => updater.getStatus(member), { code: "FORBIDDEN" });
  const status = updater.getStatus(leader);
  assert.equal(status.current.version, "TU02");
  assert.ok(Array.isArray(status.history));
});

test("fetch error (network down) -> ok:false, no throw, recorded in meta", async () => {
  writeExistingVersion({ version: "TU02", markdown: "**G101 — Title**\nBody." });
  global.fetch = async () => { throw new Error("network unreachable"); };
  const result = await updater.checkForUpdate({});
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8"));
  assert.match(meta.last_check_result, /^error:/);
});

test("non-PDF content-type is rejected", async () => {
  writeExistingVersion({ version: "TU02", markdown: "**G101 — Title**\nBody." });
  global.fetch = async () => ({
    status: 200, ok: true,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "text/html" : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const result = await updater.checkForUpdate({});
  assert.equal(result.ok, false);
  assert.match(result.error, /content-type/);
});
