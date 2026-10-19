// Creates a Google Calendar event with Meet video conferencing, using a team-owned OAuth
// refresh token (design-phase2.md §4, §8). Plain `fetch` to Google's REST endpoints - no
// googleapis dependency. NEVER throws to the caller and NEVER blocks the platform: when not
// configured, or on any failure, `createMeetingEvent` resolves to `null` and the caller falls
// back to a manually-entered link.
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_TEAM_REFRESH_TOKEN);
}

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_TEAM_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Google OAuth a eșuat (${res.status})`);
  const data = await res.json();
  if (!data.access_token) throw new Error("Google OAuth nu a întors un access_token");
  return data.access_token;
}

// `startTime`/`endTime`: ISO datetime strings. Returns { link, eventId } or null.
async function createMeetingEvent({ title, startTime, endTime }) {
  if (!isConfigured()) return null;
  try {
    const token = await getAccessToken();
    const res = await fetch(`${EVENTS_URL}?conferenceDataVersion=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        summary: title || "Ședință echipă",
        start: { dateTime: startTime },
        end: { dateTime: endTime || startTime },
        conferenceData: {
          createRequest: { requestId: `crocoai-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Google Calendar a răspuns cu eroare (${res.status})`);
    const data = await res.json();
    const entryPoints = (data.conferenceData && data.conferenceData.entryPoints) || [];
    const videoEntry = entryPoints.find((e) => e.entryPointType === "video");
    const link = data.hangoutLink || (videoEntry && videoEntry.uri) || null;
    if (!link) return null;
    return { link, eventId: data.id };
  } catch (err) {
    console.error("[GOOGLE-MEET]", err.message);
    return null;
  }
}

// Moves/renames the Google event behind an automatic Meet link (design-pachet-b.md B3). Best-effort:
// resolves true/false, never throws (the platform's own meeting is already saved).
async function updateMeetingEvent({ eventId, title, startTime, endTime }) {
  if (!isConfigured() || !eventId) return false;
  try {
    const token = await getAccessToken();
    const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ summary: title || "Ședință echipă", start: { dateTime: startTime }, end: { dateTime: endTime || startTime } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Google Calendar a răspuns cu eroare (${res.status})`);
    return true;
  } catch (err) {
    console.error("[GOOGLE-MEET] update:", err.message);
    return false;
  }
}

// Deletes the Google event (meeting cancelled, moved to a room, or its link replaced). Best-effort, never throws;
// an event already gone (404/410) counts as deleted.
async function deleteMeetingEvent(eventId) {
  if (!isConfigured() || !eventId) return false;
  try {
    const token = await getAccessToken();
    const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google Calendar a răspuns cu eroare (${res.status})`);
    return true;
  } catch (err) {
    console.error("[GOOGLE-MEET] delete:", err.message);
    return false;
  }
}

module.exports = { isConfigured, createMeetingEvent, updateMeetingEvent, deleteMeetingEvent, getAccessToken };
