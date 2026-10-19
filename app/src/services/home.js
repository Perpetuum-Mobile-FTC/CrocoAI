// Acasă (docs/design-pachet-b.md B1): every card of the personal home page in ONE call, built only from the
// domain services with `actor`. Each card is guarded: a card the actor may not see (DomainError) is null, a bug in
// one card never takes the page down. No permission logic here - the services / policy.js decide.
const { DomainError } = require("../domain/errors");
const { can } = require("../domain/policy");
const { hasAttendanceDuty } = require("../domain/rules");
const deadlines = require("./deadlines");
const announcements = require("./announcements");
const assignments = require("./assignments");
const tasks = require("./tasks");
const meetings = require("./meetings");
const attendance = require("./attendance");
const absences = require("./absences");
const documents = require("./documents");
const applications = require("./applications");
const registration = require("./registration");

function card(name, fn) {
  try { return fn(); }
  catch (err) {
    if (!(err instanceof DomainError)) console.error(`[HOME] card ${name}:`, err.message);
    return null;
  }
}

// „De verificat”: only what the actor is entitled to decide; null when they decide nothing at all.
function review(actor) {
  const items = [];
  let entitled = false;
  const subs = assignments.toReview(actor);
  if (subs.length || can(actor, "assignments.view_all") || can(actor, "assignments.view_dept")) entitled = true;
  const waiting = subs.reduce((n, a) => n + a.waiting, 0);
  if (waiting) items.push({ key: "predari", label: waiting === 1 ? "predare de verificat" : "predări de verificat", count: waiting, link: subs.length === 1 ? `/teme/${subs[0].id}` : "/teme?filtru=de-verificat" });
  if (can(actor, "absence.decide")) {
    entitled = true;
    const n = absences.list(actor, { status: "pending" }).length;
    if (n) items.push({ key: "motivari", label: n === 1 ? "cerere de motivare" : "cereri de motivare", count: n, link: "/sedinte?tab=prezenta" });
  }
  if (can(actor, "members.manage")) {
    entitled = true;
    const n = registration.listRoleRequests(actor).length;
    if (n) items.push({ key: "roluri", label: n === 1 ? "cerere de rol" : "cereri de rol", count: n, link: "/admin?tab=cereri-rol" });
  }
  if (can(actor, "onboarding.start")) {
    entitled = true;
    const n = applications.pendingCount(actor);
    if (n) items.push({ key: "inscrieri", label: n === 1 ? "cerere de înscriere" : "cereri de înscriere", count: n, link: "/echipa?tab=cereri" });
  }
  return entitled ? items : null;
}

// Which personal cards apply to this account (not a permission: mentors/alumni have no attendance duty and
// none of the student paperwork) - the UI draws only these.
function cardsFor(actor) {
  const student = hasAttendanceDuty(actor);
  return { attendance: student, absence_request: student && can(actor, "absence.request"), documents: student };
}

function summary(actor) {
  const cards = cardsFor(actor);
  return {
    cards,
    deadlines: card("deadlines", () => deadlines.list(actor)),
    announcements: card("announcements", () => announcements.list(actor, { limit: 3 })),
    can_publish: can(actor, "announcements.publish"),
    assignments: card("assignments", () => assignments.list(actor, { scope: "mine", status: "activa" })
      .filter((a) => a.my_submission && ["de_facut", "de_refacut"].includes(a.my_submission.status))
      .sort((x, y) => (x.due_at || "9999").localeCompare(y.due_at || "9999"))
      .map((a) => ({ id: a.id, title: a.title, due_at: a.due_at, status: a.my_submission.status, target_label: a.target_label }))),
    todos: card("todos", () => tasks.list(actor, { mine: true, status: "pending" })
      .map((t) => ({ id: t.id, title: t.title, due_date: t.due_date, remind_at: t.remind_at, reminded: !!t.reminded }))),
    meetings: card("meetings", () => meetings.upcomingMine(actor).slice(0, 5)),
    attendance: !cards.attendance ? null : card("attendance", () => ({
      stats: attendance.statsFor(actor, actor.id),
      pending_absences: absences.list(actor, { member_id: actor.id, status: "pending" }),
    })),
    documents: !cards.documents ? null : card("documents", () => documents.myStatus(actor, actor.id)
      .filter((d) => !d.document || d.document.status === "respins")
      .map((d) => ({ key: d.key, title: d.title, status: d.document ? d.document.status : "lipsa" }))),
    review: card("review", () => review(actor)),
  };
}

module.exports = { summary, review, cardsFor };
