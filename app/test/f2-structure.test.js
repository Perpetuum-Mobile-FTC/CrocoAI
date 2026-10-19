// Curățenie F2 item 3: meetings.js is a facade over cohesive modules (same exports), membri.js split.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv } = require("./_assign-env");
const env = initEnv("f2_structure");

const lines = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8").split("\n").length;

test("meetings facade keeps every export used elsewhere", () => {
  const meetings = require("../src/services/meetings");
  const expected = ["MAX_CHUNK_BYTES", "MEETING_SESSION_TYPES", "abandonRecording", "allowedTargets", "approve", "assertNotApproved",
    "attendanceQr", "attendanceRoster", "audioStatus", "bucharestToUtcMs", "cancel", "closeAttendance", "createMeetLinkAuto",
    "decisionsFor", "detachSharedEvent", "exportHtml", "generateDraft", "generateDraftText", "get", "getOrCreateForSession",
    "getRecording", "lastApproved", "list", "markAttendance", "parseMeeting", "qrToken", "reopenAttendance", "requireMeetingRow",
    "reschedule", "scan", "schedule", "search", "sectionAccess", "setMeetLinkManual", "startRecording", "stopRecording",
    "upcomingMine", "updateAgenda", "updateDraft", "uploadAudio", "uploadChunk"];
  assert.deepEqual(Object.keys(meetings).sort(), expected);
  require("../src/db").close();
  env.cleanup();
});

test("module sizes: meetings split, membri split", () => {
  for (const f of ["meetings.js", "meeting-core.js", "meeting-schedule.js", "meeting-minutes.js"]) {
    assert.ok(lines(`src/services/${f}`) < 400, f);
  }
  for (const f of ["membri.js", "membri-profil.js", "membri-cereri.js"]) {
    assert.ok(lines(`public/js/pages/${f}`) < 600, f);
  }
});
