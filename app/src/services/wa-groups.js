// Which WhatsApp groups the bot tracks/processes (design v2 §4, §9, audit B-HIGH-3).
// Only tracked=1 groups are processed/logged; unknown groups are inserted untracked and dropped.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");

// Called from the WA ingress webhook, NOT actor-gated (system call). New groups default untracked.
function upsertSeen(groupId, name) {
  db.prepare(`
    INSERT INTO wa_groups (group_id, name, tracked) VALUES (?, ?, 0)
    ON CONFLICT(group_id) DO UPDATE SET name = excluded.name
  `).run(groupId, name || null);
  return db.prepare("SELECT * FROM wa_groups WHERE group_id = ?").get(groupId);
}

const GATEWAY_DOWN = "Gateway-ul WhatsApp nu răspunde — lista grupurilor nu a putut fi actualizată. Încearcă din nou mai târziu.";

// Lists groups; with `sync`, first records every group the number is in (from the gateway) so
// leaders can enable the team group before anyone writes in it. New groups stay untracked.
// A sync with the gateway down is an error (UNAVAILABLE), never an empty list; without sync = what is known.
async function list(actor, { sync = false } = {}) {
  assertCan(actor, "wa_groups.manage");
  if (sync) {
    const groups = await require("./wa-gateway").fetchGroups();
    if (!groups) throw new DomainError("UNAVAILABLE", GATEWAY_DOWN);
    for (const g of groups) upsertSeen(g.id, g.name);
  }
  return db.prepare("SELECT * FROM wa_groups ORDER BY name COLLATE NOCASE").all();
}

// Admin → Grupuri WhatsApp: the synced list, or - gateway down - the known groups plus the reason they may be stale.
async function overview(actor) {
  try {
    return { groups: await list(actor, { sync: true }), gateway_error: null };
  } catch (err) {
    if (err.code !== "UNAVAILABLE") throw err;
    return { groups: await list(actor), gateway_error: err.message };
  }
}

function setTracked(actor, groupId, tracked) {
  assertCan(actor, "wa_groups.manage");
  const info = db.prepare("UPDATE wa_groups SET tracked = ? WHERE group_id = ?").run(tracked ? 1 : 0, groupId);
  if (info.changes === 0) throw new DomainError("NOT_FOUND", "Grup negăsit.");
  return db.prepare("SELECT * FROM wa_groups WHERE group_id = ?").get(groupId);
}

function isTracked(groupId) {
  const g = db.prepare("SELECT tracked FROM wa_groups WHERE group_id = ?").get(groupId);
  return !!g && !!g.tracked;
}

// Manual invite link fallback (design-phase2.md §7 ops update): the gateway's GET /group/:id/invite
// is unreliable, so LEADERS can paste a WhatsApp invite link per group for onboarding to use.
function setInviteLink(actor, groupId, link) {
  assertCan(actor, "wa_groups.manage");
  const trimmed = (link || "").trim();
  if (trimmed && !/^https:\/\/chat\.whatsapp\.com\/.+/.test(trimmed)) {
    throw new DomainError("INVALID", "Link invalid - trebuie să înceapă cu https://chat.whatsapp.com/");
  }
  const info = db.prepare("UPDATE wa_groups SET invite_link = ? WHERE group_id = ?").run(trimmed || null, groupId);
  if (info.changes === 0) throw new DomainError("NOT_FOUND", "Grup negăsit.");
  return db.prepare("SELECT * FROM wa_groups WHERE group_id = ?").get(groupId);
}

function getInviteLink(groupId) {
  const g = db.prepare("SELECT invite_link FROM wa_groups WHERE group_id = ?").get(groupId);
  return (g && g.invite_link) || null;
}

module.exports = { upsertSeen, list, overview, setTracked, isTracked, setInviteLink, getInviteLink };
