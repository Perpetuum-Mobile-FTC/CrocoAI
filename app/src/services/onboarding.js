// Onboarding voluntari noi (Art. 14, 43). Deterministic dialog over WhatsApp - NO LLM involved
// (lesson from v1, memory/lessons.md). Every function takes `actor` first, except handleReply
// which is driven by the WhatsApp gateway on behalf of the member themselves.
const { TEAM } = require("../domain/team");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const { normalizePhone } = require("../domain/phone");
const { ONBOARDING_STEPS, ONBOARDING_CHECK_DAYS } = require("../domain/rules");
const membersSvc = require("./members");
const documentsSvc = require("./documents");
const notifications = require("./notifications");
const audience = require("./audience");
const waGateway = require("./wa-gateway");
const waGroups = require("./wa-groups");
const { randomPassword } = require("./username");

const DEPARTMENTS = ["tehnic", "non-tehnic", "ambele"];

// Dialog steps (member.onboarding_step), distinct from the Art. 43.2 checklist.
const STEP = { NUME: 1, CLASA: 2, SCOALA: 3, EMAIL: 4, DATA: 5, DEPARTAMENT: 6, CONFIRMARE: 7 };

function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function getActiveByMember(memberId) {
  return db.prepare("SELECT * FROM onboarding WHERE member_id = ? AND status = 'activ' ORDER BY id DESC LIMIT 1").get(memberId);
}

function getDraft(row) {
  try { return JSON.parse(row.draft || "{}"); } catch { return {}; }
}
function setDraft(id, draft) {
  db.prepare("UPDATE onboarding SET draft = ? WHERE id = ?").run(JSON.stringify(draft), id);
}

function checklistFor(onboardingId) {
  return db.prepare(`
    SELECT c.step_key, c.done, c.done_by, c.done_at
    FROM onboarding_checklist c WHERE c.onboarding_id = ?
  `).all(onboardingId).map((c) => {
    const def = ONBOARDING_STEPS.find((s) => s.key === c.step_key);
    return { ...c, done: !!c.done, label: def ? def.label : c.step_key, article: def ? def.article : null };
  });
}

function tick(onboardingId, stepKey, byMemberId) {
  db.prepare(`
    UPDATE onboarding_checklist SET done = 1, done_by = ?, done_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE onboarding_id = ? AND step_key = ?
  `).run(byMemberId || null, onboardingId, stepKey);
}

function welcomeText() {
  return `Bun venit în echipa ${TEAM.name} #${TEAM.number}! 🐊 Sunt CrocoAI, asistentul echipei. ` +
    "Hai să te cunoaștem puțin - te rog scrie-mi *numele tău complet*.";
}

function questionFor(step, draft) {
  switch (step) {
    case STEP.CLASA: return `Mulțumesc, ${draft.name}! În ce *clasă* ești?`;
    case STEP.SCOALA: return "La ce *școală* înveți?";
    case STEP.EMAIL: return "Care este *adresa ta de email*?";
    case STEP.DATA: return "Care este *data nașterii* tale? (format zz.ll.aaaa, ex: 15.03.2010)";
    case STEP.DEPARTAMENT: return "În ce *departament* vrei să activezi: tehnic, non-tehnic sau ambele?";
    default: return null;
  }
}

function confirmareText(draft) {
  return [
    "Te rog confirmă datele:",
    `- Nume: ${draft.name}`,
    `- Clasă: ${draft.class}`,
    `- Școală: ${draft.school}`,
    `- Email: ${draft.email}`,
    `- Data nașterii: ${draft.birthdateDisplay}`,
    `- Departament: ${draft.department}`,
    "",
    'Scrie *DA* pentru a confirma, sau "corectez <câmp>" (nume, clasa, scoala, email, data, departament) pentru a corecta un câmp.',
  ].join("\n");
}

const CORRECTION_FIELDS = { nume: STEP.NUME, clasa: STEP.CLASA, scoala: STEP.SCOALA, email: STEP.EMAIL, data: STEP.DATA, departament: STEP.DEPARTAMENT };

// ── LEADERS start the process from the platform ───────────────────────────
function start(actor, { name, phone, department, buddy_id } = {}) {
  assertCan(actor, "onboarding.start");
  if (!name || !name.trim()) throw new DomainError("INVALID", "Numele e obligatoriu.");
  const digits = normalizePhone(phone);
  if (!digits) throw new DomainError("INVALID", "Telefon invalid.");
  if (db.prepare("SELECT 1 FROM members WHERE phone = ?").get(digits)) {
    throw new DomainError("INVALID", "Există deja un membru cu acest telefon.");
  }
  if (department && !DEPARTMENTS.includes(department)) throw new DomainError("INVALID", "Departament invalid.");
  let buddy = null;
  if (buddy_id) {
    buddy = membersSvc.getRaw(buddy_id);
    if (!buddy) throw new DomainError("NOT_FOUND", "Buddy negăsit.");
  }

  const created = membersSvc.create(actor, { name: name.trim(), phone: digits, role: "volunteer", department: department || "ambele" });
  db.prepare("UPDATE members SET onboarding_step = ? WHERE id = ?").run(STEP.NUME, created.id);

  const info = db.prepare(`
    INSERT INTO onboarding (member_id, buddy_id, started_by, status, draft) VALUES (?, ?, ?, 'activ', '{}')
  `).run(created.id, buddy_id || null, actor.id);
  const onboardingId = info.lastInsertRowid;
  for (const s of ONBOARDING_STEPS) {
    db.prepare("INSERT INTO onboarding_checklist (onboarding_id, step_key) VALUES (?, ?)").run(onboardingId, s.key);
  }
  if (buddy) {
    tick(onboardingId, "buddy", actor.id);
    notifications.create(buddy.id, "onboarding_buddy", "Ai fost desemnat buddy", `Ești buddy pentru ${created.name || name.trim()} în primele ședințe (Art. 43.2).`, `/membri/${created.id}`);
    waGateway.sendWhatsApp(buddy.phone, `Ai fost desemnat buddy pentru ${name.trim()}, voluntar nou în echipă. Îl/o însoțești în primele ședințe (Art. 43.2).`);
  }

  waGateway.sendWhatsApp(digits, welcomeText());

  return { member: membersSvc.getRaw(created.id), onboarding: db.prepare("SELECT * FROM onboarding WHERE id = ?").get(onboardingId), checklist: checklistFor(onboardingId) };
}

// Starts the Art. 43.2 checklist for a member whose data is already known (accepted public
// application, or a member who just completed their data via a completion link) - skips the
// WhatsApp Q&A dialog used by `start()` entirely (design-formular-date.md §2). "platforma" is
// ticked immediately since the account already exists; credentials (if any) are sent by the caller.
function startChecklistOnly(actor, memberId, { buddy_id } = {}) {
  assertCan(actor, "onboarding.start");
  const member = membersSvc.requireRaw(memberId);
  let buddy = null;
  if (buddy_id) {
    buddy = membersSvc.getRaw(buddy_id);
    if (!buddy) throw new DomainError("NOT_FOUND", "Buddy negăsit.");
  }

  const info = db.prepare(`
    INSERT INTO onboarding (member_id, buddy_id, started_by, status, draft) VALUES (?, ?, ?, 'activ', '{}')
  `).run(memberId, buddy_id || null, actor.id);
  const onboardingId = info.lastInsertRowid;
  for (const s of ONBOARDING_STEPS) {
    db.prepare("INSERT INTO onboarding_checklist (onboarding_id, step_key) VALUES (?, ?)").run(onboardingId, s.key);
  }
  tick(onboardingId, "platforma", null);
  if (buddy) {
    tick(onboardingId, "buddy", actor.id);
    notifications.create(buddy.id, "onboarding_buddy", "Ai fost desemnat buddy", `Ești buddy pentru ${member.full_name} în primele ședințe (Art. 43.2).`, `/membri/${member.id}`);
    if (membersSvc.hasPhone(buddy)) waGateway.sendWhatsApp(buddy.phone, `Ai fost desemnat buddy pentru ${member.full_name}, voluntar nou în echipă. Îl/o însoțești în primele ședințe (Art. 43.2).`);
  }

  return { onboarding: db.prepare("SELECT * FROM onboarding WHERE id = ?").get(onboardingId), checklist: checklistFor(onboardingId) };
}

// ── Deterministic WhatsApp dialog, driven by wa-incoming.js ───────────────
// Returns the text to send back to the member, or null if there's nothing to reply with
// (shouldn't normally happen - every step has a question/confirmation).
async function handleReply(member, text) {
  const onboarding = getActiveByMember(member.id);
  if (!onboarding || !member.onboarding_step) {
    return "Nu ai un proces de integrare activ momentan. Contactează un Team Leader.";
  }
  const draft = getDraft(onboarding);
  const input = String(text || "").trim();
  const step = member.onboarding_step;

  if (step === STEP.NUME) {
    if (!input) return "Te rog scrie-mi numele tău complet.";
    draft.name = input;
    return advance(member, onboarding, draft, STEP.CLASA);
  }
  if (step === STEP.CLASA) {
    if (!input) return "Te rog scrie clasa în care ești.";
    draft.class = input;
    return advance(member, onboarding, draft, STEP.SCOALA);
  }
  if (step === STEP.SCOALA) {
    if (!input) return "Te rog scrie numele școlii tale.";
    draft.school = input;
    return advance(member, onboarding, draft, STEP.EMAIL);
  }
  if (step === STEP.EMAIL) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) return "Adresa de email nu pare validă. Te rog scrie din nou (ex: nume@exemplu.ro).";
    draft.email = input;
    return advance(member, onboarding, draft, STEP.DATA);
  }
  if (step === STEP.DATA) {
    const m = input.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return "Data nu e în formatul corect. Te rog scrie în formatul zz.ll.aaaa (ex: 15.03.2010).";
    const [, dd, mm, yyyy] = m;
    const iso = `${yyyy}-${mm}-${dd}`;
    const d = new Date(iso);
    if (isNaN(d.getTime()) || d.getUTCDate() !== Number(dd) || d.getUTCMonth() + 1 !== Number(mm)) {
      return "Data nu e validă. Te rog scrie în formatul zz.ll.aaaa (ex: 15.03.2010).";
    }
    draft.birthdate = iso;
    draft.birthdateDisplay = input;
    return advance(member, onboarding, draft, STEP.DEPARTAMENT);
  }
  if (step === STEP.DEPARTAMENT) {
    const norm = stripDiacritics(input).replace(/\s+/g, "-");
    const match = DEPARTMENTS.find((d) => stripDiacritics(d) === norm || stripDiacritics(d).replace("-", "") === norm.replace("-", ""));
    if (!match) return "Te rog alege unul dintre: tehnic, non-tehnic sau ambele.";
    draft.department = match;
    setDraft(onboarding.id, draft);
    db.prepare("UPDATE members SET onboarding_step = ? WHERE id = ?").run(STEP.CONFIRMARE, member.id);
    return confirmareText(draft);
  }
  if (step === STEP.CONFIRMARE) {
    if (stripDiacritics(input) === "da") {
      return await complete(member, onboarding, draft);
    }
    const corr = stripDiacritics(input).match(/^corectez\s+(\w+)/);
    const targetStep = corr && CORRECTION_FIELDS[corr[1]];
    if (targetStep) {
      db.prepare("UPDATE members SET onboarding_step = ? WHERE id = ?").run(targetStep, member.id);
      return questionFor(targetStep, draft) || confirmareText(draft);
    }
    return confirmareText(draft);
  }
  return null;
}

function advance(member, onboarding, draft, nextStep) {
  setDraft(onboarding.id, draft);
  db.prepare("UPDATE members SET onboarding_step = ? WHERE id = ?").run(nextStep, member.id);
  return questionFor(nextStep, draft);
}

async function complete(member, onboarding, draft) {
  db.prepare(`
    UPDATE members SET full_name = ?, class = ?, school = ?, email = ?, birthdate = ?, department = ?
    WHERE id = ?
  `).run(draft.name, draft.class, draft.school, draft.email, draft.birthdate, draft.department, member.id);

  const password = randomPassword();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE members SET password_hash = ?, must_change_password = 1, onboarding_step = 0 WHERE id = ?").run(hash, member.id);

  db.prepare("UPDATE onboarding SET status = 'complet', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(onboarding.id);
  tick(onboarding.id, "platforma", null);

  const freshMember = membersSvc.getRaw(member.id);

  // Add to tracked WhatsApp groups. Fallback order on failure (ops update, design-phase2.md §7):
  // gateway invite link (if it returns 200 - unreliable, WA Web's invite module often doesn't
  // load headlessly) -> manually-stored invite_link (Admin → Grupuri WhatsApp) -> notify LEADERS
  // to add the person manually. The checklist step stays unticked unless the add actually worked.
  const groups = db.prepare("SELECT * FROM wa_groups WHERE tracked = 1").all();
  let addedAny = false;
  for (const g of groups) {
    const res = await waGateway.groupParticipants({ groupId: g.group_id, phone: freshMember.phone, action: "add" });
    if (res.ok) {
      addedAny = true;
      continue;
    }
    const link = (await waGateway.groupInvite(g.group_id)) || waGroups.getInviteLink(g.group_id);
    if (link) {
      await waGateway.sendWhatsApp(freshMember.phone, `Nu te-am putut adăuga automat în grupul "${g.name || g.group_id}" (${res.message || "eroare WhatsApp"}). Intră prin acest link: ${link}`);
    } else {
      for (const leader of audience.activeLeaders()) {
        notifications.create(leader.id, "onboarding_group_manual", "Adăugare manuală necesară în grup WhatsApp",
          `Adaugă manual pe ${freshMember.full_name} în grupul "${g.name || g.group_id}" - adăugarea automată și link-ul de invitație nu sunt disponibile (${res.message || "eroare WhatsApp"}).`, `/membri/${freshMember.id}`);
      }
    }
  }
  if (addedAny) tick(onboarding.id, "grup_whatsapp", null);

  const requiredDocs = documentsSvc.requiredFor(freshMember);
  const docsList = requiredDocs.length ? requiredDocs.map((d) => `- ${d.title}`).join("\n") : "Niciun document necesar momentan.";

  const credMsg = [
    "Bun venit oficial în echipă! 🎉",
    `Username: ${freshMember.username}`,
    `Parolă temporară: ${password} (ți se va cere s-o schimbi la prima autentificare)`,
    "",
    "Documente de semnat:",
    docsList,
  ].join("\n");
  waGateway.sendWhatsApp(freshMember.phone, credMsg);

  // Notify department head(s) + buddy.
  for (const head of audience.headsFor(freshMember.department)) {
    notifications.create(head.id, "onboarding_completed", "Voluntar nou a finalizat onboarding-ul", `${freshMember.full_name} a finalizat integrarea (Art. 43.1).`, `/membri/${freshMember.id}`);
    if (membersSvc.hasPhone(head)) waGateway.sendWhatsApp(head.phone, `${freshMember.full_name} a finalizat procesul de integrare. Verifică lista de documente și bifează pașii rămași (Art. 43).`);
  }
  if (onboarding.buddy_id) {
    const buddy = membersSvc.getRaw(onboarding.buddy_id);
    if (buddy) notifications.create(buddy.id, "onboarding_completed", "Voluntarul tău a finalizat onboarding-ul", `${freshMember.full_name} a finalizat integrarea - amintește-ți de primele 3 ședințe (Art. 43.2).`, `/membri/${freshMember.id}`);
  }

  return "Perfect, contul tău e activ! Ți-am trimis username-ul, parola temporară și lista de documente. Bine ai venit! 🐊";
}

// Called by documents.js (lazy require there, to avoid a circular dependency) after a document
// gets approved - ticks the "documente" checklist item once ALL required docs are approved.
function onDocumentApproved(memberId) {
  const onboarding = db.prepare("SELECT * FROM onboarding WHERE member_id = ? ORDER BY id DESC LIMIT 1").get(memberId);
  if (!onboarding) return;
  const member = membersSvc.getRaw(memberId);
  if (!member) return;
  const required = documentsSvc.myStatus({ id: memberId, role: "team_leader" }, memberId);
  const allApproved = required.every((d) => d.document && d.document.status === "aprobat");
  if (allApproved) tick(onboarding.id, "documente", null);
}

// ── MANAGERS: checklist + overview ────────────────────────────────────────
function overdue(row) {
  const started = new Date(row.started_at).getTime();
  const days = (Date.now() - started) / (24 * 3600 * 1000);
  return row.status === "activ" && days > ONBOARDING_CHECK_DAYS;
}

function list(actor) {
  assertCan(actor, "onboarding.manage");
  const rows = db.prepare(`
    SELECT o.*, m.full_name AS member_name, m.department AS member_department
    FROM onboarding o JOIN members m ON m.id = o.member_id
    ORDER BY o.started_at DESC
  `).all();
  return rows.map((r) => {
    const checklist = checklistFor(r.id);
    return {
      id: r.id,
      member_id: r.member_id,
      member_name: r.member_name,
      department: r.member_department,
      status: r.status,
      started_at: r.started_at,
      completed_at: r.completed_at,
      buddy_id: r.buddy_id,
      checklist,
      complete: checklist.every((c) => c.done),
      overdue: overdue(r), // Art. 43.3: semnal la 30 de zile dacă nu e complet
    };
  });
}

function detail(actor, memberId) {
  const onboarding = db.prepare("SELECT * FROM onboarding WHERE member_id = ? ORDER BY id DESC LIMIT 1").get(memberId);
  if (!onboarding) throw new DomainError("NOT_FOUND", "Niciun proces de integrare pentru acest membru.");
  assertCan(actor, "onboarding.view", { member_id: memberId });
  return { ...onboarding, checklist: checklistFor(onboarding.id), overdue: overdue(onboarding) };
}

function setTick(actor, memberId, stepKey, done) {
  assertCan(actor, "onboarding.manage");
  if (!ONBOARDING_STEPS.some((s) => s.key === stepKey)) throw new DomainError("INVALID", "Pas de integrare necunoscut.");
  const onboarding = db.prepare("SELECT * FROM onboarding WHERE member_id = ? ORDER BY id DESC LIMIT 1").get(memberId);
  if (!onboarding) throw new DomainError("NOT_FOUND", "Niciun proces de integrare pentru acest membru.");
  if (done) tick(onboarding.id, stepKey, actor.id);
  else db.prepare("UPDATE onboarding_checklist SET done = 0, done_by = NULL, done_at = NULL WHERE onboarding_id = ? AND step_key = ?").run(onboarding.id, stepKey);
  return detail(actor, memberId);
}

function restart(actor, memberId) {
  assertCan(actor, "onboarding.manage");
  const member = membersSvc.requireRaw(memberId);
  membersSvc.assertCanEditAccount(actor, member); // the dialog rewrites data + password: TL only for TL/co-leader/mentor
  const prev = db.prepare("SELECT * FROM onboarding WHERE member_id = ? AND status = 'activ'").get(memberId);
  if (prev) db.prepare("UPDATE onboarding SET status = 'anulat' WHERE id = ?").run(prev.id);
  db.prepare("UPDATE members SET onboarding_step = ? WHERE id = ?").run(STEP.NUME, memberId);
  const info = db.prepare("INSERT INTO onboarding (member_id, buddy_id, started_by, status, draft) VALUES (?, ?, ?, 'activ', '{}')")
    .run(memberId, prev ? prev.buddy_id : null, actor.id);
  for (const s of ONBOARDING_STEPS) {
    db.prepare("INSERT INTO onboarding_checklist (onboarding_id, step_key) VALUES (?, ?)").run(info.lastInsertRowid, s.key);
  }
  if (membersSvc.hasPhone(member)) waGateway.sendWhatsApp(member.phone, welcomeText());
  return detail(actor, memberId);
}

function cancel(actor, memberId) {
  assertCan(actor, "onboarding.manage");
  const onboarding = db.prepare("SELECT * FROM onboarding WHERE member_id = ? AND status = 'activ'").get(memberId);
  if (!onboarding) throw new DomainError("NOT_FOUND", "Niciun proces de integrare activ pentru acest membru.");
  db.prepare("UPDATE onboarding SET status = 'anulat' WHERE id = ?").run(onboarding.id);
  db.prepare("UPDATE members SET onboarding_step = 0 WHERE id = ?").run(memberId);
  return { ok: true };
}

// For the Acasă dashboard (MANAGERS) + the AI tool: which onboarding processes are overdue.
function overdueSignals(actor) {
  assertCan(actor, "onboarding.manage");
  return list(actor).filter((o) => o.overdue && !o.complete);
}

module.exports = {
  start,
  startChecklistOnly,
  handleReply,
  onDocumentApproved,
  list,
  detail,
  setTick,
  restart,
  cancel,
  overdueSignals,
  STEP,
};
