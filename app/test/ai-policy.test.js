// Unit tests for the single AI scope/refusal/crisis/limits definition (docs/design-ai-hardening.md §1, §6).
const { test } = require("node:test");
const assert = require("node:assert");
const aiPolicy = require("../src/domain/ai-policy");

test("applyTags: [REFUZ:off_topic] replaces the WHOLE reply with the fixed text", () => {
  const { text, flagCategory } = aiPolicy.applyTags("Sigur, iată eseul tău despre Luceafărul... [REFUZ:off_topic]");
  assert.equal(text, aiPolicy.REFUSAL_TEXTS.off_topic);
  assert.equal(flagCategory, "off_topic");
});

for (const category of aiPolicy.REFUSAL_CATEGORIES) {
  test(`applyTags: [REFUZ:${category}] -> fixed text for that category`, () => {
    const { text, flagCategory } = aiPolicy.applyTags(`[REFUZ:${category}]`);
    assert.equal(text, aiPolicy.REFUSAL_TEXTS[category]);
    assert.equal(flagCategory, category);
  });
}

test("applyTags: [CRIZA] replaces the WHOLE reply with the crisis text, category 'criza'", () => {
  const { text, flagCategory } = aiPolicy.applyTags("Nu mai vreau... [CRIZA]");
  assert.equal(text, aiPolicy.CRISIS_TEXT);
  assert.equal(flagCategory, "criza");
  assert.match(text, /112/);
  assert.match(text, /116 111/);
});

test("applyTags: CRIZA wins over a REFUZ tag if both somehow appear", () => {
  const { flagCategory } = aiPolicy.applyTags("[REFUZ:off_topic] [CRIZA]");
  assert.equal(flagCategory, "criza");
});

test("applyTags: unknown category tag falls back to off_topic rather than leaking the raw tag", () => {
  const { text, flagCategory } = aiPolicy.applyTags("[REFUZ:ceva_inexistent]");
  assert.equal(flagCategory, "off_topic");
  assert.equal(text, aiPolicy.REFUSAL_TEXTS.off_topic);
});

test("applyTags: no tag -> text passes through unchanged, flagCategory null", () => {
  const { text, flagCategory } = aiPolicy.applyTags("Ai 3 taskuri deschise.");
  assert.equal(text, "Ai 3 taskuri deschise.");
  assert.equal(flagCategory, null);
});

test("tooLong: respects AI_MAX_INPUT_CHARS override, read dynamically", () => {
  process.env.AI_MAX_INPUT_CHARS = "10";
  assert.equal(aiPolicy.tooLong("12345678901"), true);
  assert.equal(aiPolicy.tooLong("short"), false);
  delete process.env.AI_MAX_INPUT_CHARS;
});

test("tooLongReply mentions the configured limit", () => {
  assert.match(aiPolicy.tooLongReply(), /scurtează/i);
});

test("truncateReply: adds an ellipsis only when the text exceeds the limit", () => {
  process.env.AI_MAX_REPLY_CHARS = "10";
  assert.equal(aiPolicy.truncateReply("short"), "short");
  const truncated = aiPolicy.truncateReply("this is definitely too long");
  assert.equal(truncated.length, 10);
  assert.ok(truncated.endsWith("…"));
  delete process.env.AI_MAX_REPLY_CHARS;
});

test("dailyMemberLimit: LEADERS get 3x the member base, read dynamically from env", () => {
  process.env.AI_DAILY_LIMIT_MEMBER = "7";
  assert.equal(aiPolicy.dailyMemberLimit({ role: "member" }), 7);
  assert.equal(aiPolicy.dailyMemberLimit({ role: "team_leader", status: "activ" }), 21);
  // A5: a leader who is not active counts as a plain member
  assert.equal(aiPolicy.dailyMemberLimit({ role: "team_leader", status: "pauza" }), 7);
  delete process.env.AI_DAILY_LIMIT_MEMBER;
});

test("estimateInputTokens: roughly chars/3 across text + history bodies", () => {
  const n = aiPolicy.estimateInputTokens({ text: "123456789", history: [{ body: "123456789" }] });
  assert.equal(n, 6); // 18 chars / 3
});

test("wouldExceedBudget: true when estimate + already-used would exceed the daily budget", () => {
  process.env.AI_DAILY_TOKEN_BUDGET = "100";
  assert.equal(aiPolicy.wouldExceedBudget({ text: "x".repeat(300), history: [], globalTokensToday: 50 }), true);
  assert.equal(aiPolicy.wouldExceedBudget({ text: "x".repeat(3), history: [], globalTokensToday: 0 }), false);
  delete process.env.AI_DAILY_TOKEN_BUDGET;
});

test("buildSystemPrompt mentions scope, the tag protocol and the FTC manual tool", () => {
  const prompt = aiPolicy.buildSystemPrompt();
  assert.match(prompt, /\[REFUZ:off_topic\]/);
  assert.match(prompt, /\[CRIZA\]/);
  assert.match(prompt, /cauta_manual_ftc/);
  assert.match(prompt, /nu menționezi niciodată tool-uri/i);
});
