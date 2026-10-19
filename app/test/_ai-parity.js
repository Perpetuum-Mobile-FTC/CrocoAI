// AI tool <-> HTTP route parity table (Regula de aur, CLAUDE.md): every AI tool has an entry here with the
// route that does the same thing and how the tool's arguments map onto it. test/f2-ai-parity.test.js fails
// when a tool has no entry (or an entry has no tool), runs the `cases` below, and checks `coveredBy`.
//
// Entry: { route: "METHOD /path" | null, args: "tool args -> route params" (doc), why?: reason when route is null,
//          coveredBy?: test file that already compares tool and route, cases?: [case] }
// case: { as: member key, tool(ctx) -> tool args, http(ctx) -> { method, path, body? }, expect(json, ctx) -> tool text,
//         normalize?(text) applied to both sides (e.g. row ids when tool and route write different rows) }
//   A non-2xx route answer means the tool must return isError with the same `error (article)` text.
//   For writes, tool() and http() each create their own fixture (they must not share one row).
const format = require("../src/ai/format");
const profile = require("../src/domain/profile");

const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const PARITY = {
  // ─── tools.js ───
  profilul_meu: {
    route: "GET /api/members/:id", args: "id = the writer",
    cases: [
      { as: "member", tool: () => ({}), http: (c) => ({ path: `/api/members/${c.M.member.id}` }), expect: (j) => format.formatProfile(j) },
      { as: "tl", tool: () => ({}), http: (c) => ({ path: `/api/members/${c.M.tl.id}` }), expect: (j) => format.formatProfile(j) },
    ],
  },
  taskurile_mele: { route: "GET /api/tasks?mine=1", args: "-", coveredBy: "ai-consistency.test.js" },
  creeaza_task: {
    route: "POST /api/tasks", args: "titlu -> title, membru_id -> assigned_member_id, scadent -> due_date",
    cases: [
      {
        as: "member", tool: () => ({ titlu: "Paritate AI", scadent: "2030-01-15" }),
        http: () => ({ method: "POST", path: "/api/tasks", body: { title: "Paritate AI", due_date: "2030-01-15" } }),
        expect: (j) => `Task creat: ${j.title}${j.due_date ? ` (scadent ${j.due_date})` : ""}.`,
      },
      { // a plain member assigning someone else: same refusal
        as: "member", tool: (c) => ({ titlu: "Pentru altul", membru_id: c.M.other.id }),
        http: (c) => ({ method: "POST", path: "/api/tasks", body: { title: "Pentru altul", assigned_member_id: c.M.other.id } }),
        expect: () => { throw new Error("route should refuse"); },
      },
      {
        as: "tl", tool: (c) => ({ titlu: "Pentru membru", membru_id: c.M.member.id }),
        http: (c) => ({ method: "POST", path: "/api/tasks", body: { title: "Pentru membru", assigned_member_id: c.M.member.id } }),
        expect: (j) => `Task creat: ${j.title}.`,
      },
    ],
  },
  actualizeaza_task: {
    route: "PATCH /api/tasks/:id", args: "id -> :id, status -> status (status only = updateStatus), titlu -> title, scadent -> due_date, membru_id -> assigned_member_id",
    cases: [
      {
        as: "member", tool: (c) => ({ id: c.task(c.M.member).id, status: "done" }),
        http: (c) => ({ method: "PATCH", path: `/api/tasks/${c.task(c.M.member).id}`, body: { status: "done" } }),
        expect: (j) => `Task actualizat: ${j.title} [${j.status}].`,
      },
      {
        as: "member", tool: (c) => ({ id: c.task(c.M.member).id, titlu: "Titlu nou" }),
        http: (c) => ({ method: "PATCH", path: `/api/tasks/${c.task(c.M.member).id}`, body: { title: "Titlu nou" } }),
        expect: (j) => `Task actualizat: ${j.title} [${j.status}].`,
      },
      { // someone else's task: same refusal
        as: "member", tool: (c) => ({ id: c.task(c.M.other).id, status: "done" }),
        http: (c) => ({ method: "PATCH", path: `/api/tasks/${c.task(c.M.other).id}`, body: { status: "done" } }),
        expect: () => { throw new Error("route should refuse"); },
      },
    ],
  },
  evenimente_urmatoare: {
    route: "GET /api/events?from&to", args: "zile -> from = now, to = now + zile (default 14)",
    cases: [
      {
        as: "member", tool: () => ({ zile: 10 }),
        http: () => ({ path: `/api/events?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 10 * 86400000).toISOString())}` }),
        expect: (j) => format.formatEvents(j),
      },
    ],
  },
  prezenta: { route: "GET /api/attendance/stats?member_id", args: "membru_id -> member_id (default: writer)", coveredBy: "ai-consistency.test.js" },
  cere_motivare_absenta: { route: "POST /api/absences", args: "sesiune_id -> session_id, data -> date, motiv -> reason", coveredBy: "ai-consistency.test.js" },
  decide_motivare: {
    route: "POST /api/absences/:id/decide", args: "id -> :id, status -> status, nota -> note",
    cases: [
      {
        as: "tl", tool: (c) => ({ id: c.absence().id, status: "aprobata" }),
        http: (c) => ({ method: "POST", path: `/api/absences/${c.absence().id}/decide`, body: { status: "aprobata" } }),
        expect: (j) => `Cerere #${j.id}: ${j.status}.`,
        normalize: (t) => t.replace(/#\d+/, "#N"), // tool and route decide two different requests
      },
      {
        as: "member", tool: (c) => ({ id: c.absence().id, status: "respinsa" }),
        http: (c) => ({ method: "POST", path: `/api/absences/${c.absence().id}/decide`, body: { status: "respinsa" } }),
        expect: () => { throw new Error("route should refuse"); },
      },
    ],
  },
  creeaza_reminder: { route: "POST /api/tasks (remind_at)", args: "mesaj -> title, cand -> remind_at, membru_id/membru_telefon -> assigned member", coveredBy: "ai-consistency.test.js" },
  documentele_mele: { route: "GET /api/documents/me", args: "-", coveredBy: "ai-consistency.test.js" },
  documente_lipsa_echipa: {
    route: "GET /api/documents/matrix", args: "-",
    cases: [
      { as: "tl", tool: () => ({}), http: () => ({ path: "/api/documents/matrix" }), expect: (j) => format.formatMissingDocuments(j) },
      { as: "member", tool: () => ({}), http: () => ({ path: "/api/documents/matrix" }), expect: () => { throw new Error("route should refuse"); } },
    ],
  },
  cauta_membru: {
    route: "GET /api/members", args: "query -> name filter (diacritics/case-insensitive) over the directory",
    cases: [
      {
        as: "member", tool: () => ({ query: "membru paritate" }), http: () => ({ path: "/api/members" }),
        expect: (j) => {
          const m = j.filter((x) => strip(x.name).includes("membru paritate"));
          return m.length ? m.map((x) => `#${x.id} ${format.formatMember(x)}`).join("\n") : "Niciun membru găsit.";
        },
      },
      { as: "member", tool: () => ({ query: "nimeni-asa" }), http: () => ({ path: "/api/members" }), expect: () => "Niciun membru găsit." },
    ],
  },
  cauta_regulament: { route: "GET /api/regulament/search?q", args: "intrebare -> q", coveredBy: "ai-consistency.test.js" },
  cauta_manual_ftc: { route: "GET /api/ftc-docs/search?q", args: "intrebare -> q", coveredBy: "ai-consistency.test.js" },
  trimite_whatsapp: {
    route: null, args: "catre_telefon, mesaj -> pending action (sent after DA)",
    why: "AI-only: creates a pending send confirmed by DA (services/conversation.js); the platform has no send route",
    coveredBy: "ai-consistency.test.js",
  },

  // ─── tools-meetings.js ───
  ultimul_proces_verbal: { route: "GET /api/meetings/last-approved", args: "-", coveredBy: "meetings-ai-consistency.test.js" },
  cauta_procese_verbale: { route: "GET /api/meetings/search?q", args: "text -> q", coveredBy: "meetings-ai-consistency.test.js" },
  deciziile_sedintei: { route: "GET /api/meetings/decisions?date", args: "data -> date", coveredBy: "meetings-ai-consistency.test.js" },
  // ─── tools-photos.js ───
  acordul_meu_foto: { route: "GET /api/photos/consent/me", args: "-", coveredBy: "photos-ai-consistency.test.js" },
  pozele_mele: { route: "GET /api/photos/albums/:id/photos (tagged)", args: "-", coveredBy: "photos-ai-consistency.test.js" },
  poze_nepublicabile: { route: "GET /api/photos/unpublishable", args: "-", coveredBy: "photos-ai-consistency.test.js" },
  // ─── tools-onboarding.js ───
  stare_onboarding: { route: "GET /api/onboarding", args: "-", coveredBy: "onboarding-routes.test.js" },
  // ─── tools-announcements.js ───
  anunturi_recente: {
    route: "GET /api/announcements?limit", args: "numar -> limit (default 10)",
    cases: [
      {
        as: "member", tool: () => ({ numar: 5 }), http: () => ({ path: "/api/announcements?limit=5" }),
        expect: (j) => (j.length ? j.map((a) => `- [${format.formatDateTime(a.created_at)}] ${a.title}${a.audience === "echipa" ? "" : ` (${a.audience_label})`} — ${a.author_name}${a.body ? `: ${a.body}` : ""}`).join("\n") : "Niciun anunț momentan."),
      },
    ],
  },
  // ─── tools-registration.js ───
  datele_mele_lipsa: {
    route: "GET /api/members/missing-data (the writer's row)", args: "-",
    why: "no self route: the same members.myMissingFields / profile.missingFields as the LEADERS list",
    cases: [
      {
        as: "tl", tool: () => ({}), http: () => ({ path: "/api/members/missing-data" }),
        expect: (j, c) => {
          const row = j.find((r) => r.id === c.M.tl.id);
          return row ? `Îți lipsesc: ${row.missing.map((f) => profile.FIELD_LABELS[f] || f).join(", ")}. Le poți completa din Membri → profilul tău → Editează, sau printr-un link de completare primit de la un Team Leader.` : "Profilul tău este complet.";
        },
      },
    ],
  },
  membri_date_incomplete: {
    route: "GET /api/members/missing-data", args: "-",
    cases: [
      {
        as: "tl", tool: () => ({}), http: () => ({ path: "/api/members/missing-data" }),
        expect: (j) => (j.length ? j.map((r) => `- ${r.name}: lipsește ${r.missing.map((f) => profile.FIELD_LABELS[f] || f).join(", ")}`).join("\n") : "Toți membrii au profilul complet."),
      },
      { as: "member", tool: () => ({}), http: () => ({ path: "/api/members/missing-data" }), expect: () => { throw new Error("route should refuse"); } },
    ],
  },
  cereri_inscriere: { route: "GET /api/applications/pending-count", args: "-", coveredBy: "registration.test.js" },
  // ─── tools-assignments.js ───
  temele_mele: { route: "GET /api/assignments?scope=mine&status=activa", args: "-", coveredBy: "assignments-ai-consistency.test.js" },
  detalii_tema: { route: "GET /api/assignments/:id", args: "tema_id -> :id", coveredBy: "assignments-ai-consistency.test.js" },
  status_predari_tema: { route: "GET /api/assignments/:id (progress)", args: "tema_id -> :id", coveredBy: "assignments-ai-consistency.test.js" },
  // ─── tools-resources.js ───
  cauta_resurse: { route: "GET /api/resources?q&category", args: "query -> q, category -> category", coveredBy: "resources.test.js" },
};

module.exports = { PARITY };
