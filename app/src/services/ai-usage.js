// ai_usage: write path used by ai/agent.js after every model call, read path for LEADERS.
const db = require("../db");
const { assertCan } = require("../domain/policy");
const { bucharestDayStartIso } = require("../domain/time");
const aiPolicy = require("../domain/ai-policy");

// Records one query() call. `member` may be null (shouldn't happen in practice - every call has
// an actor - but kept defensive).
function record({ member, channel, model, usage, cost_usd, tool_calls }) {
  const u = usage || {};
  db.prepare(`
    INSERT INTO ai_usage (member_id, channel, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    member ? member.id : null,
    channel,
    model || null,
    u.input_tokens || 0,
    u.output_tokens || 0,
    u.cache_read_input_tokens || 0,
    u.cache_creation_input_tokens || 0,
    cost_usd || 0,
    tool_calls || 0
  );
}

// Calls + tokens used by `memberId` today (Europe/Bucharest calendar day), and the global token total today.
function todayUsage(memberId, now = new Date()) {
  const since = bucharestDayStartIso(now.getTime());
  const mine = db.prepare(`
    SELECT COUNT(*) AS calls FROM ai_usage WHERE member_id = ? AND created_at >= ?
  `).get(memberId, since);
  const global = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM ai_usage WHERE created_at >= ?
  `).get(since);
  return { callsToday: mine.calls, globalTokensToday: global.tokens };
}

// Total AI cost (USD) today, Europe/Bucharest day.
function costToday(now = new Date()) {
  return db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_usage WHERE created_at >= ?").get(bucharestDayStartIso(now.getTime())).c;
}

// Scheduler (every tick): today's cost above AI_DAILY_COST_ALERT_USD -> tell the active Team Leader(s)
// once per Bucharest day (in-app + WhatsApp to a verified phone). Dedup = an 'ai_cost' notification
// already created today.
async function checkDailyCost(now = new Date()) {
  const cost = costToday(now);
  const limit = aiPolicy.dailyCostAlertUsd();
  if (cost <= limit) return false;
  if (db.prepare("SELECT 1 FROM notifications WHERE type = 'ai_cost' AND created_at >= ?").get(bucharestDayStartIso(now.getTime()))) return false;
  const { whatsappPhone } = require("./members");
  const notifications = require("./notifications");
  const waGateway = require("./wa-gateway");
  const title = "Cost AI ridicat azi";
  const body = `Consumul AI de azi a ajuns la $${cost.toFixed(2)} (pragul e $${limit.toFixed(2)}). Detalii: Admin → Consum AI.`;
  for (const m of require("./audience").activeTeamLeaders()) {
    notifications.create(m.id, "ai_cost", title, body, "/admin");
    const phone = whatsappPhone(m);
    if (phone) await waGateway.sendWhatsApp(phone, `⚠️ ${title}: ${body}`);
  }
  return true;
}

// Calls made by `memberId` in the last `windowMs` (burst limit, design-ai-hardening.md §1).
function callsInWindow(memberId, windowMs) {
  const since = new Date(Date.now() - windowMs).toISOString();
  return db.prepare(`SELECT COUNT(*) AS c FROM ai_usage WHERE member_id = ? AND created_at >= ?`).get(memberId, since).c;
}

// Records a flag (refusal category, crisis, or limit hit) — content-free by design.
function recordFlag({ member_id, channel, category }) {
  db.prepare(`INSERT INTO ai_flags (member_id, channel, category) VALUES (?, ?, ?)`).run(member_id || null, channel, category);
}

function summary(actor, { from, to } = {}) {
  assertCan(actor, "ai_usage.view");
  let sql = "SELECT ai_usage.*, members.full_name AS member_name FROM ai_usage LEFT JOIN members ON members.id = ai_usage.member_id WHERE 1=1";
  const params = [];
  if (from) { sql += " AND ai_usage.created_at >= ?"; params.push(from); }
  if (to) { sql += " AND ai_usage.created_at <= ?"; params.push(to); }
  sql += " ORDER BY ai_usage.created_at DESC LIMIT 500";
  const rows = db.prepare(sql).all(...params);
  const totals = rows.reduce((acc, r) => ({
    input_tokens: acc.input_tokens + r.input_tokens,
    output_tokens: acc.output_tokens + r.output_tokens,
    cost_usd: acc.cost_usd + r.cost_usd,
    calls: acc.calls + 1,
  }), { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 });
  return { totals, rows };
}

// Per-member usage for the last `days` days (default 7) — design-ai-hardening.md §5.
function byMember(actor, { days } = {}) {
  assertCan(actor, "ai_usage.view");
  const since = new Date(Date.now() - (Number(days) || 7) * 86400000).toISOString();
  const todayStart = bucharestDayStartIso(Date.now());
  return db.prepare(`
    SELECT members.id AS member_id, members.full_name AS member_name,
      COUNT(*) AS calls_period, COALESCE(SUM(ai_usage.input_tokens + ai_usage.output_tokens), 0) AS tokens_period,
      COALESCE(SUM(ai_usage.cost_usd), 0) AS cost_period,
      SUM(CASE WHEN ai_usage.created_at >= ? THEN 1 ELSE 0 END) AS calls_today,
      SUM(CASE WHEN ai_usage.created_at >= ? THEN ai_usage.input_tokens + ai_usage.output_tokens ELSE 0 END) AS tokens_today
    FROM ai_usage JOIN members ON members.id = ai_usage.member_id
    WHERE ai_usage.created_at >= ?
    GROUP BY members.id ORDER BY tokens_period DESC
  `).all(todayStart, todayStart, since);
}

// Refusal/limit/crisis counts by category (content-free, design-ai-hardening.md §5).
function flagsSummary(actor, { days } = {}) {
  assertCan(actor, "ai_usage.view");
  const since = new Date(Date.now() - (Number(days) || 7) * 86400000).toISOString();
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) AS count FROM ai_flags WHERE created_at >= ? GROUP BY category
  `).all(since);
  const crisisSignals = db.prepare(`
    SELECT ai_flags.created_at, ai_flags.channel, members.full_name AS member_name
    FROM ai_flags LEFT JOIN members ON members.id = ai_flags.member_id
    WHERE ai_flags.category = 'criza' AND ai_flags.created_at >= ? ORDER BY ai_flags.created_at DESC
  `).all(since);
  const limitHits = db.prepare(`
    SELECT members.id AS member_id, members.full_name AS member_name, COUNT(*) AS count
    FROM ai_flags JOIN members ON members.id = ai_flags.member_id
    WHERE ai_flags.category = 'limita' AND ai_flags.created_at >= ? GROUP BY members.id ORDER BY count DESC
  `).all(since);
  return { byCategory, crisisSignals, limitHits };
}

module.exports = { summary, record, todayUsage, costToday, checkDailyCost, callsInWindow, recordFlag, byMember, flagsSummary };
