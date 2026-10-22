const { DomainError } = require("./errors");

// The ONLY definition of team rules (seasons, thresholds, deadlines, signals), each with an
// article reference. The platform and the AI agent must display the exact text generated here,
// never reformulated (design v2 §5, §94).

// Whether a "motivat" (excused) absence counts as a miss for the percentage. Single switch per design.
// Owner decision 2026-10-01 (overrides design-v2 §5 default): motivated absences do NOT reduce
// the percentage - pct = prezent / (prezent + absent), motivat shown separately, scutit excluded.
const MOTIVATED_COUNTS_AS_ABSENCE = false;

// Session types that count towards the attendance percentage (Art. 19, 51.4). "competitie" is
// tracked separately (Art. 22); "antrenament"/"eveniment" are informative only.
const COUNTING_SESSION_TYPES = ["sedinta", "urgenta"];

const PAUSE_MAX_WEEKS = 8; // Art. 57.3
const PAUSE_ONBOARDING_WEEKS = 4; // Art. 57.5
const ABSENCE_NOTICE_HOURS = 24; // Art. 21.1
const COMPETITION_NOTICE_DAYS = 7; // Art. 22.1
const LATE_MOTIVATION_HOURS = 48; // Art. 21.1: unforeseen situations (illness, emergency) - up to 48h AFTER the meeting
const WARNING_THRESHOLD = 3; // Art. 20.2: written warning at 3 unexcused absences in the season, consecutive or not
const TOTAL_DISCUSSION_THRESHOLD = 5; // Art. 20.3: TL + mentor discussion at the 5th unexcused absence of the season

// Art. 22.1 / 22.2: regional + national competitions are mandatory; international ones are only expected
// (non-participation carries no sanctions). Existing competitions default to 'regional' (mandatory).
const COMPETITION_LEVELS = ["regional", "national", "international"];
const DEFAULT_COMPETITION_LEVEL = "regional";
const MANDATORY_COMPETITION_LEVELS = ["regional", "national"]; // Art. 22.1
// „Văzut ultima dată”: an authenticated request updates members.last_seen_at at most this often.
const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;
const MIN_SESSIONS_FOR_PCT_SIGNAL = 4; // Art. 20.1, avoid noise with too few data points

// Season id "2026-2027" for any date between 2026-09-01 and 2027-08-31 (sep -> aug).
function seasonFor(date) {
  const d = date instanceof Date ? date : new Date(date);
  const month = d.getUTCMonth() + 1; // 1-12
  const year = d.getUTCFullYear();
  const startYear = month >= 9 ? year : year - 1;
  const id = `${startYear}-${startYear + 1}`;
  // Active season: September - February. Extra-season: March - August.
  const active = month >= 9 || month <= 2;
  return {
    id,
    active,
    threshold: active ? 0.75 : 0.5,
    thresholdPct: active ? 75 : 50,
    label: active ? "sezon activ" : "extra-sezon",
    article: "Art. 20.1",
    from: `${startYear}-09-01`,
    to: `${startYear + 1}-08-31`,
  };
}

// Percent = prezent / (prezent + absent + motivat), on counting sessions, in the current season.
// `statuses` = array of 'prezent' | 'absent' | 'motivat' | 'scutit'. 'scutit' (pause) is excluded entirely.
function computeAttendancePct(statuses) {
  const relevant = statuses.filter((s) => s !== "scutit");
  const present = relevant.filter((s) => s === "prezent").length;
  const denomStatuses = MOTIVATED_COUNTS_AS_ABSENCE
    ? relevant
    : relevant.filter((s) => s !== "motivat");
  if (denomStatuses.length === 0) return null;
  return Math.round((present / denomStatuses.length) * 1000) / 10; // one decimal
}

// Competition level to store for a session/event of `type`: null for non-competitions; for a
// competition the given level (validated), else `current`, else the default (Art. 22.1).
function resolveCompetitionLevel(type, level, current) {
  if (type !== "competitie") return null;
  if (level === undefined || level === null || level === "") return current || DEFAULT_COMPETITION_LEVEL;
  if (!COMPETITION_LEVELS.includes(level)) {
    throw new DomainError("INVALID", `Nivel de competiție invalid (${COMPETITION_LEVELS.join(", ")}).`, "Art. 22");
  }
  return level;
}

// Builds the signal list (NOT automatic sanctions - TL + Co-Leader decide, Art. 30.1).
// `records` = chronological array of { date, status, session_type } for ONE member, already
// filtered to counting session types within the current season.
function computeSignals({ records, pctAllTime, sessionCount, pauseWeeks, pauseReturnGapWeeks, warnedThisSeason = false }) {
  const signals = [];

  // Art. 20.2: total unexcused absences in the season (consecutive or not). Not repeated for a member
  // who already got a written warning (or worse) this season (`warnedThisSeason`).
  const totalUnexcused = records.filter((r) => r.status === "absent").length;
  if (totalUnexcused >= WARNING_THRESHOLD && !warnedThisSeason) {
    signals.push({
      code: "avertisment_nemotivate_sezon",
      article: "Art. 20.2",
      message: `Avertisment scris recomandat — ${totalUnexcused} absențe nemotivate în acest sezon (Art. 20.2).`,
    });
  }

  if (totalUnexcused >= TOTAL_DISCUSSION_THRESHOLD) {
    signals.push({
      code: "total_nemotivate_sezon",
      article: "Art. 20.3",
      message: `Discuție TL + mentor — ${totalUnexcused} absențe nemotivate în acest sezon (Art. 20.3).`,
    });
  }

  if (pctAllTime !== null && sessionCount >= MIN_SESSIONS_FOR_PCT_SIGNAL) {
    const season = seasonFor(new Date());
    if (pctAllTime < season.thresholdPct) {
      signals.push({
        code: "sub_prag",
        article: "Art. 20.1",
        message: `Sub pragul minim de prezență — ${pctAllTime}% din ședințe, sub pragul de ${season.thresholdPct}% pentru ${season.label} (Art. 20.1).`,
      });
    }
  }

  if (pauseWeeks !== undefined && pauseWeeks !== null && pauseWeeks > PAUSE_MAX_WEEKS) {
    signals.push({
      code: "pauza_depasita",
      article: "Art. 57.3",
      message: `Pauza depășește maximul — ${pauseWeeks} săptămâni, peste limita de ${PAUSE_MAX_WEEKS} săptămâni per sezon (Art. 57.3).`,
    });
  }

  if (pauseReturnGapWeeks !== undefined && pauseReturnGapWeeks !== null && pauseReturnGapWeeks > PAUSE_ONBOARDING_WEEKS) {
    signals.push({
      code: "revenire_onboarding",
      article: "Art. 57.5",
      message: `Revenire după pauză de ${pauseReturnGapWeeks} săptămâni (peste ${PAUSE_ONBOARDING_WEEKS}) — necesită parcurgerea pașilor de onboarding (Art. 57.5).`,
    });
  }

  return signals;
}

// Absence request deadline check. `sessionType` = 'competitie' uses the 7-day rule (Art. 22.1),
// everything else uses the 24h rule (Art. 21.1). `competitionLevel` 'international' has no deadline and
// no sanctions (Art. 22.2). After the session started, a request is still accepted up to
// LATE_MOTIVATION_HOURS later (Art. 21.1, unforeseen situations); beyond that it is refused.
// Returns { status, onTime, ulterioara, expired, article, requiredHours, message? } where status is
// 'in_termen' | 'tardiva' (too late before the start) | 'ulterioara' (after the start, <= 48h) | 'expirata'.
function checkAbsenceNotice({ now, sessionStart, sessionType, competitionLevel }) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const startMs = (sessionStart instanceof Date ? sessionStart : new Date(sessionStart)).getTime();
  const diffHours = (startMs - nowMs) / 3600000;
  const isCompetition = sessionType === "competitie";
  const make = (status, article, requiredHours, message) => ({
    status, onTime: status === "in_termen", ulterioara: status === "ulterioara", expired: status === "expirata", article, requiredHours, message,
  });
  if (isCompetition && competitionLevel === "international") return make("in_termen", "Art. 22.2", 0);
  const article = isCompetition ? "Art. 22.1" : "Art. 21.1";
  const requiredHours = isCompetition ? COMPETITION_NOTICE_DAYS * 24 : ABSENCE_NOTICE_HOURS;
  if (diffHours >= requiredHours) return make("in_termen", article, requiredHours);
  if (diffHours >= 0) return make("tardiva", article, requiredHours);
  if (-diffHours <= LATE_MOTIVATION_HOURS) return make("ulterioara", "Art. 21.1", requiredHours);
  return make("expirata", "Art. 21.1", requiredHours,
    `Termenul de motivare a expirat: în situații neprevăzute absența se poate motiva cel mult ${LATE_MOTIVATION_HOURS} de ore după ședință (Art. 21.1).`);
}

// Who is on the attendance roster of whole-team sessions (Art. 11, 12: mentors and alumni guide the team, they have
// no attendance duty). Also decides the student-only Acasă cards (Prezența mea, Cere motivare, documente lipsă).
const NO_ATTENDANCE_ROLES = ["mentor", "alumni"];
function hasAttendanceDuty(member) {
  return !!member && !NO_ATTENDANCE_ROLES.includes(member.role || "member");
}

// Art. 21.1: a motivation request says why (min length, so an empty / one-letter request isn't sent to the managers).
const ABSENCE_REASON_MIN = 3;
const ABSENCE_REASON_MAX = 1000;
function absenceReasonError(reason) {
  const s = typeof reason === "string" ? reason.trim() : "";
  if (s.length < ABSENCE_REASON_MIN) return `Scrie motivul absenței (cel puțin ${ABSENCE_REASON_MIN} caractere).`;
  if (s.length > ABSENCE_REASON_MAX) return `Motivul poate avea cel mult ${ABSENCE_REASON_MAX} de caractere.`;
  return null;
}

// Minor = age < 18 today, from birthdate. Unknown birthdate -> treated as minor (documents, Art. 14.2/59/50.3).
function isMinor(birthdate, now = new Date()) {
  if (!birthdate) return true;
  const b = new Date(birthdate);
  if (isNaN(b.getTime())) return true;
  const ref = now instanceof Date ? now : new Date(now);
  let age = ref.getFullYear() - b.getFullYear();
  const m = ref.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < b.getDate())) age--;
  return age < 18;
}

// --- Faza 2 (design-phase2.md §3) ---
const MINUTES_RETENTION_SEASONS = 3; // Art. 49.2: procese verbale — 3 sezoane
const MAJOR_DECISION_NOTICE_DAYS = 3; // Art. 47.3: propunere cu minimum 3 zile înainte
const BUDDY_SESSIONS = 3; // Art. 43.2: buddy în primele 3 ședințe
const ONBOARDING_CHECK_DAYS = 30; // Art. 43.3: verificare la finalul primei luni
// Art. 43.2 — pașii procesului de integrare, în ordinea din regulament
const ONBOARDING_STEPS = [
  { key: "prezentare", label: "Prezentarea echipei, a structurii și a regulamentului intern", article: "Art. 43.2" },
  { key: "platforma", label: "Acces la platforma CrocoAI", article: "Art. 43.2" },
  { key: "grup_whatsapp", label: "Adăugare în grupul oficial de WhatsApp", article: "Art. 43.2" },
  { key: "buddy", label: `Buddy alocat pentru primele ${BUDDY_SESSIONS} ședințe`, article: "Art. 43.2" },
  { key: "siguranta", label: "Sesiune de siguranță în laborator (Art. 36.5)", article: "Art. 43.2" },
  { key: "documente", label: "Anexa 5 și Anexa 6 semnate", article: "Art. 14.2" },
];

// Art. 59.1–59.3, 45.4: o poză se poate publica doar dacă TOȚI membrii etichetați au acordul foto/video
// (Anexa 13) aprobat și neretras. `consents` = [{ member_id, name, approved: bool, withdrawn: bool }].
function photoPublication(consents) {
  const missing = consents.filter((c) => !c.approved || c.withdrawn);
  if (!missing.length) return { publishable: true, article: "Art. 59.1", message: "Toți membrii etichetați au acordul foto/video." };
  return {
    publishable: false,
    article: "Art. 59.2",
    missing: missing.map((c) => c.member_id),
    message: `Nu se publică: lipsește acordul foto/video (Anexa 13) pentru ${missing.map((c) => c.name).join(", ")} (Art. 59, 45.4).`,
  };
}

// Art. 49.2: un PV aprobat poate fi arhivat/șters doar după 3 sezoane complete.
function minutesRetentionUntil(meetingDate) {
  const season = seasonFor(meetingDate);
  const startYear = Number(String(season.id).slice(0, 4));
  return { until: `${startYear + MINUTES_RETENTION_SEASONS}-09-01`, article: "Art. 49.2" };
}

// Who signs each document and how to submit it (design v2 §7) — the ONLY definition; the
// Documente page and the AI agent both show this text. `minor` = rules.isMinor(member.birthdate).
const DOCUMENT_SIGNERS = {
  anexa5_confidentialitate: { minor: "Semnezi tu și părintele/tutorele.", adult: "Semnezi tu.", article: "Art. 14.2" },
  anexa6_regulament: { minor: "Semnezi tu și părintele/tutorele.", adult: "Semnezi tu.", article: "Art. 14.2" },
  anexa13_foto_video: { minor: "Semnează părintele/tutorele.", adult: "Semnezi tu.", article: "Art. 59.2" },
  fisa_medicala: { minor: "Completează părintele/tutorele (vizibilă doar ție, Team Leader-ului și mentorilor, în caz de urgență).", adult: "O completezi tu (vizibilă doar ție, Team Leader-ului și mentorilor, în caz de urgență).", article: "Art. 58.3" },
  first_policies: { minor: "Semnează părintele/tutorele, pe varianta pentru minori.", adult: "Semnezi tu, pe varianta pentru majori.", article: "program FTC România" },
  consimtamant_participanti_majori: { minor: "Nu se aplică minorilor.", adult: "Semnezi tu.", article: "program FTC" },
  consimtamant_imagine_majori: { minor: "Nu se aplică minorilor.", adult: "Semnezi tu.", article: "program FTC" },
  acord_parental_deplasare: { minor: "Semnează părintele/tutorele, cu cel puțin 7 zile înainte de deplasare.", adult: "Nu se aplică majorilor.", article: "Art. 50.3" },
};
const DOCUMENT_STEPS = "Pași: deschide pagina Documente din CrocoAI → „Descarcă șablonul” → semnează → „Încarcă” (scan sau poză clară) → îl aprobă Team Leader-ul sau Co-Leader-ul.";

function documentGuidance(typeKey, minor) {
  const s = DOCUMENT_SIGNERS[typeKey];
  return { who_signs: s ? (minor ? s.minor : s.adult) : null, steps: DOCUMENT_STEPS };
}

// Resurse (biblioteca comună de fișiere și linkuri), ordinea = ordinea afișată.
const RESOURCE_CATEGORIES = [
  { key: "regulamente", label: "Regulamente & FIRST" },
  { key: "sponsorizari", label: "Sponsorizări & fundraising" },
  { key: "pr", label: "PR & comunicare" },
  { key: "programare", label: "Programare" },
  { key: "mecanica", label: "Mecanică" },
  { key: "proiectare", label: "Proiectare (CAD)" },
  { key: "organizare", label: "Organizare proiecte" },
  { key: "altele", label: "Altele" },
];
// Cloudflare tunnel caps request bodies at 100 MB; stay well under.
const RESOURCE_MAX_FILE_SIZE = 50 * 1024 * 1024;

// ── Securitate (docs/design-securitate-2026-10.md, decizie Luca 2026-10-16) - no Regulament article ──
// A1: one password policy everywhere (change, reset, registration). 72 = bcrypt's input limit.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const TEMP_PASSWORD_LENGTH = 12;
function passwordError(pw) {
  const s = typeof pw === "string" ? pw : "";
  if (s.length < PASSWORD_MIN) return `Parola trebuie să aibă cel puțin ${PASSWORD_MIN} caractere.`;
  if (s.length > PASSWORD_MAX) return `Parola poate avea cel mult ${PASSWORD_MAX} de caractere.`;
  return null;
}
// A3: registration confirmed with a WhatsApp code.
const OTP_CODE_TTL_MIN = 10;
const PENDING_REGISTRATION_TTL_MIN = 30;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_AFTER_SEC = 60;
const OTP_MAX_PER_PHONE_HOUR = 3;
const OTP_MAX_PER_PHONE_DAY = 6;
// Per IP: a school Wi-Fi shares one address (same reasoning as the 30/hour registration limit).
function otpMaxPerIpHour() { return Number(process.env.OTP_MAX_PER_IP_HOUR) || 30; }
// All codes, all phones: caps how much the shared WhatsApp number can be made to send.
// Data retention (cleanup F1; GDPR art. 5(1)(e) "limitarea stocării"; Regulament Art. 41.1 doar datele necesare,
// 41.8 + 49 perioade). Applied daily by services/retention.js. Change a period here, nowhere else.
const RETENTION = {
  // Rejected public applications (Art. 14): nothing to keep them for once decided.
  rejectedApplications: { months: 6, article: "Art. 41.1, 41.8" },
  // WhatsApp message log (`messages`, `wa_message_log`), web AI chat, ai_flags rows; ai_usage aggregates stay.
  messageLogs: { days: 90, article: "Art. 41.1" },
  // Meeting audio is a working file for the PV draft; the transcript stays with the approved PV (Art. 49.2: 3 sezoane).
  meetingAudio: { daysAfterApproval: 30, article: "Art. 49.2" },
  // History of the team chat removed in pachet B (chat_* tables, no UI any more).
  oldTeamChat: { days: 90, article: "Art. 41.1" },
  // Medical-sheet access log (audit_log): long enough to answer an access request or an incident, not forever.
  auditLog: { years: 2, article: "Art. 41.2, 41.7" },
};

// Art. 41.8: la ieșirea din echipă (status 'iesit') fișa medicală se distruge automat (rânduri + fișiere);
// retenția zilnică acoperă membrii deja ieșiți. La reactivare nu se restaurează nimic (se încarcă o fișă nouă).
const MEDICAL_DESTRUCTION = { typeKey: "fisa_medicala", auditAction: "medical_destroyed", article: "Art. 41.8" };

function otpMaxGlobalHour() { return Number(process.env.OTP_MAX_GLOBAL_HOUR) || 60; }
// A3: caps on what one account can make the bot send.
const TASK_TITLE_MAX = 200;
const MAX_ACTIVE_REMINDERS_PER_MEMBER = 20;

module.exports = {
  LAST_SEEN_RESOLUTION_MS,
  RETENTION,
  MEDICAL_DESTRUCTION,
  PASSWORD_MIN,
  PASSWORD_MAX,
  TEMP_PASSWORD_LENGTH,
  passwordError,
  OTP_CODE_TTL_MIN,
  PENDING_REGISTRATION_TTL_MIN,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_AFTER_SEC,
  OTP_MAX_PER_PHONE_HOUR,
  OTP_MAX_PER_PHONE_DAY,
  otpMaxPerIpHour,
  otpMaxGlobalHour,
  TASK_TITLE_MAX,
  MAX_ACTIVE_REMINDERS_PER_MEMBER,
  RESOURCE_CATEGORIES,
  RESOURCE_MAX_FILE_SIZE,
  DOCUMENT_SIGNERS,
  DOCUMENT_STEPS,
  documentGuidance,
  MINUTES_RETENTION_SEASONS,
  MAJOR_DECISION_NOTICE_DAYS,
  BUDDY_SESSIONS,
  ONBOARDING_CHECK_DAYS,
  ONBOARDING_STEPS,
  photoPublication,
  minutesRetentionUntil,
  MOTIVATED_COUNTS_AS_ABSENCE,
  COUNTING_SESSION_TYPES,
  PAUSE_MAX_WEEKS,
  PAUSE_ONBOARDING_WEEKS,
  ABSENCE_NOTICE_HOURS,
  COMPETITION_NOTICE_DAYS,
  WARNING_THRESHOLD,
  LATE_MOTIVATION_HOURS,
  COMPETITION_LEVELS,
  DEFAULT_COMPETITION_LEVEL,
  MANDATORY_COMPETITION_LEVELS,
  resolveCompetitionLevel,
  TOTAL_DISCUSSION_THRESHOLD,
  seasonFor,
  computeAttendancePct,
  computeSignals,
  checkAbsenceNotice,
  NO_ATTENDANCE_ROLES,
  hasAttendanceDuty,
  ABSENCE_REASON_MIN,
  ABSENCE_REASON_MAX,
  absenceReasonError,
  isMinor,
};
