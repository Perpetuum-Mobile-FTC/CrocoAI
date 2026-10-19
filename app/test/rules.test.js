const { test } = require("node:test");
const assert = require("node:assert");
const rules = require("../src/domain/rules");

test("seasonFor: active season sep-feb at 75%, extra-season mar-aug at 50%", () => {
  assert.equal(rules.seasonFor("2026-10-15").active, true);
  assert.equal(rules.seasonFor("2026-10-15").thresholdPct, 75);
  assert.equal(rules.seasonFor("2026-10-15").id, "2026-2027");
  assert.equal(rules.seasonFor("2027-01-05").id, "2026-2027");
  assert.equal(rules.seasonFor("2027-04-01").active, false);
  assert.equal(rules.seasonFor("2027-04-01").thresholdPct, 50);
});

test("computeAttendancePct: motivated absences do NOT reduce the percentage (owner decision)", () => {
  // 2 prezent, 1 absent, 1 motivat -> pct = 2 / (2+1) = 67%, motivat excluded from denominator.
  assert.equal(rules.computeAttendancePct(["prezent", "prezent", "absent", "motivat"]), 66.7);
  assert.equal(rules.MOTIVATED_COUNTS_AS_ABSENCE, false);
});

test("computeAttendancePct: scutit (pause) always excluded", () => {
  assert.equal(rules.computeAttendancePct(["prezent", "scutit", "scutit"]), 100);
  assert.equal(rules.computeAttendancePct(["scutit", "scutit"]), null);
});

test("computeAttendancePct: empty/all-excluded -> null", () => {
  assert.equal(rules.computeAttendancePct([]), null);
});

test("signals: 3 unexcused absences in the season, consecutive -> Art. 20.2", () => {
  const records = [
    { status: "prezent" }, { status: "absent" }, { status: "absent" }, { status: "absent" },
  ];
  const signals = rules.computeSignals({ records, pctAllTime: null, sessionCount: 4 });
  const s = signals.find((s) => s.code === "avertisment_nemotivate_sezon");
  assert.ok(s, "expected warning signal");
  assert.equal(s.article, "Art. 20.2");
  assert.doesNotMatch(s.message, /consecutiv/);
});

test("signals: 3 NON-consecutive unexcused absences also trigger Art. 20.2", () => {
  const records = [
    { status: "absent" }, { status: "absent" }, { status: "prezent" }, { status: "absent" },
  ];
  const signals = rules.computeSignals({ records, pctAllTime: null, sessionCount: 4 });
  const s = signals.find((s) => s.code === "avertisment_nemotivate_sezon");
  assert.ok(s);
  assert.match(s.message, /3 absențe nemotivate în acest sezon/);
});

test("signals: 2 unexcused absences -> no Art. 20.2 warning; motivat does not count", () => {
  const records = [{ status: "absent" }, { status: "motivat" }, { status: "absent" }, { status: "motivat" }];
  const signals = rules.computeSignals({ records, pctAllTime: null, sessionCount: 4 });
  assert.equal(signals.find((s) => s.code === "avertisment_nemotivate_sezon"), undefined);
});

test("signals: no repeat Art. 20.2 warning when already warned this season (dedupe)", () => {
  const records = [{ status: "absent" }, { status: "absent" }, { status: "absent" }];
  const signals = rules.computeSignals({ records, pctAllTime: null, sessionCount: 3, warnedThisSeason: true });
  assert.equal(signals.find((s) => s.code === "avertisment_nemotivate_sezon"), undefined);
});

test("signals: Art. 20.3 discussion only at the 5th unexcused absence of the season", () => {
  assert.equal(rules.TOTAL_DISCUSSION_THRESHOLD, 5);
  const mk = (n) => Array.from({ length: n }, () => ({ status: "absent" }));
  const at4 = rules.computeSignals({ records: mk(4), pctAllTime: null, sessionCount: 4 });
  assert.equal(at4.find((s) => s.code === "total_nemotivate_sezon"), undefined);
  const at5 = rules.computeSignals({ records: mk(5), pctAllTime: null, sessionCount: 5 });
  const s = at5.find((s) => s.code === "total_nemotivate_sezon");
  assert.ok(s);
  assert.equal(s.article, "Art. 20.3");
  assert.match(s.message, /5 absențe nemotivate/);
});

test("signals: below season threshold with >= 4 sessions -> Art. 20.1", () => {
  const records = [{ status: "prezent" }, { status: "absent" }, { status: "absent" }, { status: "absent" }];
  const signals = rules.computeSignals({ records, pctAllTime: 40, sessionCount: 4 });
  const s = signals.find((s) => s.code === "sub_prag");
  assert.ok(s);
  assert.equal(s.article, "Art. 20.1");
});

test("signals: below threshold but < 4 sessions -> no sub_prag noise", () => {
  const records = [{ status: "absent" }];
  const signals = rules.computeSignals({ records, pctAllTime: 0, sessionCount: 1 });
  assert.equal(signals.find((s) => s.code === "sub_prag"), undefined);
});

test("signals: pause beyond 8 weeks -> Art. 57.3", () => {
  const signals = rules.computeSignals({ records: [], pctAllTime: null, sessionCount: 0, pauseWeeks: 9 });
  const s = signals.find((s) => s.code === "pauza_depasita");
  assert.ok(s);
  assert.equal(s.article, "Art. 57.3");
});

test("checkAbsenceNotice: 24h rule for regular sessions (Art. 21.1)", () => {
  const now = new Date("2026-10-10T10:00:00Z");
  const onTime = rules.checkAbsenceNotice({ now, sessionStart: "2026-10-11T12:00:00Z", sessionType: "sedinta" });
  assert.equal(onTime.onTime, true);
  assert.equal(onTime.article, "Art. 21.1");
  const late = rules.checkAbsenceNotice({ now, sessionStart: "2026-10-10T20:00:00Z", sessionType: "sedinta" });
  assert.equal(late.onTime, false);
});

test("checkAbsenceNotice: 7-day rule for competitions (Art. 22.1)", () => {
  const now = new Date("2026-10-01T10:00:00Z");
  const onTime = rules.checkAbsenceNotice({ now, sessionStart: "2026-10-10T10:00:00Z", sessionType: "competitie" });
  assert.equal(onTime.onTime, true);
  const late = rules.checkAbsenceNotice({ now, sessionStart: "2026-10-05T10:00:00Z", sessionType: "competitie" });
  assert.equal(late.onTime, false);
  assert.equal(late.article, "Art. 22.1");
});

test("isMinor: under 18 -> true, 18+ -> false, unknown -> true (design default)", () => {
  const now = new Date("2026-10-01");
  assert.equal(rules.isMinor("2010-01-01", now), true);
  assert.equal(rules.isMinor("2005-01-01", now), false);
  assert.equal(rules.isMinor(null, now), true);
  assert.equal(rules.isMinor(undefined, now), true);
});

test("checkAbsenceNotice: after the meeting, within 48h -> accepted as 'ulterioara' (Art. 21.1)", () => {
  const sessionStart = "2026-10-12T14:00:00Z";
  const r = rules.checkAbsenceNotice({ now: new Date("2026-10-13T13:00:00Z"), sessionStart, sessionType: "sedinta" });
  assert.equal(r.status, "ulterioara");
  assert.equal(r.ulterioara, true);
  assert.equal(r.onTime, false);
  assert.equal(r.expired, false);
  const edge = rules.checkAbsenceNotice({ now: new Date("2026-10-14T14:00:00Z"), sessionStart, sessionType: "sedinta" });
  assert.equal(edge.status, "ulterioara"); // exactly 48h
  assert.equal(rules.LATE_MOTIVATION_HOURS, 48);
});

test("checkAbsenceNotice: more than 48h after the meeting -> expired with Art. 21.1 message", () => {
  const r = rules.checkAbsenceNotice({ now: new Date("2026-10-14T14:01:00Z"), sessionStart: "2026-10-12T14:00:00Z", sessionType: "sedinta" });
  assert.equal(r.status, "expirata");
  assert.equal(r.expired, true);
  assert.equal(r.article, "Art. 21.1");
  assert.match(r.message, /48 de ore/);
});

test("checkAbsenceNotice: before the start but under 24h stays 'tardiva'", () => {
  const r = rules.checkAbsenceNotice({ now: new Date("2026-10-12T10:00:00Z"), sessionStart: "2026-10-12T14:00:00Z", sessionType: "sedinta" });
  assert.equal(r.status, "tardiva");
});

test("checkAbsenceNotice: international competition has no deadline and is never tardive (Art. 22.2)", () => {
  for (const now of ["2026-10-09T10:00:00Z", "2026-10-10T09:00:00Z", "2026-12-01T10:00:00Z"]) {
    const r = rules.checkAbsenceNotice({ now: new Date(now), sessionStart: "2026-10-10T10:00:00Z", sessionType: "competitie", competitionLevel: "international" });
    assert.equal(r.status, "in_termen");
    assert.equal(r.article, "Art. 22.2");
  }
});

test("checkAbsenceNotice: national competition keeps the 7-day rule (Art. 22.1)", () => {
  const r = rules.checkAbsenceNotice({ now: new Date("2026-10-05T10:00:00Z"), sessionStart: "2026-10-10T10:00:00Z", sessionType: "competitie", competitionLevel: "national" });
  assert.equal(r.status, "tardiva");
  assert.equal(r.article, "Art. 22.1");
});

test("resolveCompetitionLevel: default regional, validation, null for non-competitions (Art. 22)", () => {
  assert.equal(rules.resolveCompetitionLevel("competitie", undefined), "regional");
  assert.equal(rules.resolveCompetitionLevel("competitie", "international"), "international");
  assert.equal(rules.resolveCompetitionLevel("competitie", undefined, "national"), "national");
  assert.equal(rules.resolveCompetitionLevel("sedinta", "national"), null);
  assert.throws(() => rules.resolveCompetitionLevel("competitie", "mondial"), (e) => e.code === "INVALID");
});
