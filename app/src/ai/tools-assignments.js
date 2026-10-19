// AI tools for Teme (design-teme-grupuri.md §6). Read-only, thin wrappers over services/assignments
// with `actor` bound - the bot sees exactly what the platform shows.
const assignmentsSvc = require("../services/assignments");
const { fmtDue } = require("../services/assignment-notify");
const { DomainError } = require("../domain/errors");

const STATUS = { de_facut: "de făcut", predat: "predat, așteaptă verificarea", de_refacut: "de refăcut", acceptat: "acceptat" };

function formatList(list) {
  if (!list.length) return "Nu ai teme active.";
  return list.map((a) => `#${a.id} ${a.title} — ${a.target_label}, termen: ${fmtDue(a.due_at)}, status: ${a.my_submission ? STATUS[a.my_submission.status] : "—"}`).join("\n");
}

function formatDetail(d) {
  const lines = [`#${d.id} ${d.title} (${d.mode === "grup" ? "temă de grup" : "individuală"}, ${d.target_label})`, `Termen: ${fmtDue(d.due_at)}. Dată de ${d.created_by_name}.`];
  if (d.description) lines.push(`Descriere: ${d.description}`);
  if (d.materials.length) lines.push(`Materiale: ${d.materials.map((m) => m.filename).join(", ")} (descărcare din platformă, pagina Teme).`);
  const s = d.my_submission;
  if (s) {
    lines.push(`Statusul tău: ${STATUS[s.status]}${s.late ? " (întârziat)" : ""}.`);
    for (const t of s.todos) lines.push(`${t.done ? "[x]" : "[ ]"} ${t.text}${t.assignee_name ? ` (${t.assignee_name})` : ""}`);
    if (s.review_comment) lines.push(`Comentariu la verificare: ${s.review_comment}`);
  }
  return lines.join("\n");
}

function formatStatus(d) {
  if (!d.submissions) throw new DomainError("FORBIDDEN", "Doar cine a dat tema, liderii, mentorii și șeful departamentului văd predările.");
  const by = (st) => d.submissions.filter((s) => s.status === st).map((s) => s.member_name || "grupul");
  return [
    `#${d.id} ${d.title}: ${d.progress.acceptat} acceptate, ${d.progress.predat} de verificat, ${d.progress.de_facut + d.progress.de_refacut} nepredate din ${d.progress.total}.`,
    `De verificat: ${by("predat").join(", ") || "—"}`,
    `N-au predat: ${[...by("de_facut"), ...by("de_refacut")].join(", ") || "—"}`,
  ].join("\n");
}

function build({ tool, z, safe, actor }) {
  return [
    tool(
      "temele_mele",
      "Temele ACTIVE primite în platformă de cel care scrie (date de șefii de departament, lideri de grup sau mentori — NU teme școlare): id, titlu, termen, status.",
      {},
      safe(() => formatList(assignmentsSvc.list(actor, { scope: "mine", status: "activa" })))
    ),
    tool(
      "detalii_tema",
      "Detaliile unei teme din platformă după id: descriere, materiale, to-do-ul celui care scrie, status, comentariul ultimei verificări.",
      { tema_id: z.number().int() },
      safe(({ tema_id }) => formatDetail(assignmentsSvc.get(actor, tema_id)))
    ),
    tool(
      "status_predari_tema",
      "Pentru cine a dat tema (sau lideri/mentori): cine n-a predat și ce e de verificat la o temă, după id.",
      { tema_id: z.number().int() },
      safe(({ tema_id }) => formatStatus(assignmentsSvc.get(actor, tema_id)))
    ),
  ];
}

module.exports = { build };
