// Talks to the moldfix-wa gateway container (whatsapp-web.js).
const GATEWAY_URL = () => process.env.WA_GATEWAY_URL || "http://moldfix-wa:8099";
// Cheia partajată a gateway-ului (header X-Lucid-Key, aceeaşi valoare ca LUCID_INTERNAL_KEY din LUCID).
// Fără ea în env nu se trimite nimic în plus — gateway-ul fără cheie setată se comportă ca înainte.
const auth = (extra = {}) => (process.env.LUCID_INTERNAL_KEY ? { ...extra, "X-Lucid-Key": process.env.LUCID_INTERNAL_KEY } : extra);

async function sendWhatsApp(to, text) {
  try {
    const r = await fetch(GATEWAY_URL() + "/send", {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error("gateway status " + r.status);
    return true;
  } catch (err) {
    console.error("[WA-GATEWAY] send failed:", err.message);
    return false;
  }
}

// Whether a phone is reachable on WhatsApp (GET /resolve/:number), design-formular-date.md §2. Three outcomes, so callers
// can tell "this number has no WhatsApp" from "we couldn't ask": { wid } | { notOnWhatsApp: true } | { unavailable: true }.
async function resolve(phone) {
  try {
    const r = await fetch(GATEWAY_URL() + `/resolve/${encodeURIComponent(phone)}`, { headers: auth(), signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return { notOnWhatsApp: true };
    if (!r.ok) throw new Error("gateway status " + r.status);
    const data = await r.json();
    return data && data.wid ? { wid: data.wid } : { notOnWhatsApp: true };
  } catch (err) {
    console.error("[WA-GATEWAY] resolve failed:", err.message);
    return { unavailable: true };
  }
}

// Groups the shared number is in, from the gateway (GET /groups). null (not []) if the gateway is unreachable,
// so "no groups" and "couldn't ask" stay different.
async function fetchGroups() {
  try {
    const r = await fetch(GATEWAY_URL() + "/groups", { headers: auth(), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("gateway status " + r.status);
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("[WA-GATEWAY] groups failed:", err.message);
    return null;
  }
}

// Adds/removes a phone from a tracked WhatsApp group (design-phase2.md §7). Returns the
// gateway's { ok, code, message } as-is (code mirrors WhatsApp's own: 200/403/404/408/409);
// { ok: false, code: 0, message } if the gateway itself is unreachable.
async function groupParticipants({ groupId, phone, action }) {
  try {
    const r = await fetch(GATEWAY_URL() + "/group/participants", {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ groupId, phone, action }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, code: data.code || r.status, message: data.message || "Eroare gateway." };
    return { ok: !!data.ok, code: data.code || r.status, message: data.message };
  } catch (err) {
    console.error("[WA-GATEWAY] groupParticipants failed:", err.message);
    return { ok: false, code: 0, message: "Gateway inaccesibil." };
  }
}

// Invite link fallback when the gateway refuses to add a participant directly (privacy settings).
async function groupInvite(groupId) {
  try {
    const r = await fetch(GATEWAY_URL() + `/group/${encodeURIComponent(groupId)}/invite`, { headers: auth(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const data = await r.json();
    return data.link || null;
  } catch (err) {
    console.error("[WA-GATEWAY] groupInvite failed:", err.message);
    return null;
  }
}

module.exports = { sendWhatsApp, resolve, fetchGroups, groupParticipants, groupInvite };
