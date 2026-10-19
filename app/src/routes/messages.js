const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const messages = require("../services/messages");
const reminderScheduler = require("../services/reminder-scheduler");

const router = express.Router();

router.get("/messages", requireAuth, wrap((req, res) => {
  res.json(messages.list(req.user, req.query));
}));

router.get("/whatsapp/status", requireAuth, async (req, res) => {
  const gatewayUrl = process.env.WA_GATEWAY_URL || "http://moldfix-wa:8099";
  try {
    const r = await fetch(gatewayUrl + "/health", { signal: AbortSignal.timeout(4000) });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.json({ connected: false, error: "Gateway inaccesibil" });
  }
});

// Real health check (design v2 §10): DB query, scheduler tick age, gateway reachability,
// AI configured (any provider of the fallback chain) + ai_provider (id of the provider in use, or "none").
// `ok` reflects DB + scheduler + gateway only - the AI fields never flip it.
router.get("/health", async (req, res) => {
  const checks = { db: false, scheduler: false, gateway: false, ai_configured: require("../ai/providers").isConfigured(),
    ai_provider: require("../ai/providers").activeProvider() };
  try {
    db.prepare("SELECT 1").get();
    checks.db = true;
  } catch { /* checks.db stays false */ }

  const lastTick = reminderScheduler.getLastTickAt();
  checks.scheduler = !!lastTick && (Date.now() - lastTick.getTime()) < 3 * 60 * 1000;

  try {
    const gatewayUrl = process.env.WA_GATEWAY_URL || "http://moldfix-wa:8099";
    const r = await fetch(gatewayUrl + "/health", { signal: AbortSignal.timeout(4000) });
    checks.gateway = r.ok;
  } catch { /* checks.gateway stays false */ }

  const ok = checks.db && checks.scheduler && checks.gateway;
  res.status(ok ? 200 : 503).json({ ok, time: new Date().toISOString(), checks });
});

module.exports = router;
