// In-process MCP tool server (Claude Agent SDK) — every tool is a thin wrapper over the SAME
// domain services the HTTP routes use, called with `actor` = the member who wrote the message.
// No business logic lives here (design v2 §1, §8). A DomainError from a service becomes a
// tool_result with isError=true carrying the exact Romanian message + article, so the model's
// answer is the platform's refusal, verbatim.
const { z } = require("zod");

const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const { normalizePhone } = require("../domain/phone");
const { GROUP_PUBLIC_TOOLS } = require("../domain/ai-policy");

const membersSvc = require("../services/members");
const tasksSvc = require("../services/tasks");
const eventsSvc = require("../services/events");
const attendanceSvc = require("../services/attendance");
const absencesSvc = require("../services/absences");
const remindersSvc = require("../services/reminders");
const documentsSvc = require("../services/documents");
const regulamentSvc = require("../services/regulament");
const ftcDocsSvc = require("../services/ftc-docs");

const format = require("./format");
const pending = require("./pending");

function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function errorResult(err) {
  const article = err.article ? ` (${err.article})` : "";
  return { content: [{ type: "text", text: `${err.message}${article}` }], isError: true };
}

// Wraps a tool handler: DomainError -> tool_result isError=true with the exact message+article;
// any other error -> generic isError so the model doesn't invent an explanation.
function safe(fn) {
  return async (args) => {
    try {
      const text = await fn(args);
      return textResult(text);
    } catch (err) {
      if (err instanceof DomainError) return errorResult(err);
      console.error("[AI-TOOL]", err.stack || err.message);
      return { content: [{ type: "text", text: "A apărut o eroare tehnică la executarea acestei acțiuni." }], isError: true };
    }
  };
}

// Tools that change data (trimite_whatsapp only creates a pending send, still a write). The AI
// fallback chain never retries an attempt on the next provider once one of these succeeded
// (docs/design-ai-fallback.md). Every tool in tools-<modul>.js is read-only.
const WRITE_TOOLS = new Set([
  "creeaza_task", "actualizeaza_task", "cere_motivare_absenta", "decide_motivare", "creeaza_reminder", "trimite_whatsapp",
]);

function resolveMemberByPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  return db.prepare("SELECT * FROM members WHERE phone = ?").get(digits);
}

// Builds the tool definition array with `actor` bound into every tool's closure. Exported
// separately from buildToolServer so consistency tests can call `tool.handler(args)` directly
// without going through the MCP transport. `channel`/`chatId` are needed only by
// trimite_whatsapp (pending-action confirmation scope). `isGroup` (WhatsApp group chat, A4): only the
// public tools of ai-policy.GROUP_PUBLIC_TOOLS - nothing personal is reachable from a group.
async function buildToolList({ actor, channel, chatId, isGroup = false }) {
  const { tool } = await import("@anthropic-ai/claude-agent-sdk");

  const tools = [
    tool(
      "profilul_meu",
      "Returnează profilul membrului care scrie (nume, rol, status, contact).",
      {},
      safe(() => format.formatProfile(membersSvc.getProfile(actor, actor.id)))
    ),

    tool(
      "taskurile_mele",
      "Listează taskurile asignate membrului care scrie.",
      {},
      safe(() => format.formatTasks(tasksSvc.list(actor, { mine: true })))
    ),

    tool(
      "creeaza_task",
      "Creează un task nou. Dacă membru_id lipsește, taskul e pentru cel care scrie. Asignarea altcuiva necesită rol de MANAGER.",
      {
        titlu: z.string().min(1).describe("Titlul taskului"),
        membru_id: z.number().int().optional().describe("ID-ul membrului asignat (opțional, altfel pentru tine)"),
        scadent: z.string().optional().describe("Data scadentă, format YYYY-MM-DD"),
      },
      safe(({ titlu, membru_id, scadent }) => {
        const t = tasksSvc.create(actor, { title: titlu, assigned_member_id: membru_id, due_date: scadent });
        return `Task creat: ${t.title}${t.due_date ? ` (scadent ${t.due_date})` : ""}.`;
      })
    ),

    tool(
      "actualizeaza_task",
      "Actualizează un task existent (status, titlu, dată scadentă sau reasignare).",
      {
        id: z.number().int(),
        status: z.enum(["pending", "done"]).optional(),
        titlu: z.string().optional(),
        scadent: z.string().optional(),
        membru_id: z.number().int().optional(),
      },
      safe(({ id, status, titlu, scadent, membru_id }) => {
        let t;
        if (status && !titlu && scadent === undefined && membru_id === undefined) {
          t = tasksSvc.updateStatus(actor, id, status);
        } else {
          t = tasksSvc.update(actor, id, { title: titlu, due_date: scadent, assigned_member_id: membru_id });
        }
        return `Task actualizat: ${t.title} [${t.status}].`;
      })
    ),

    tool(
      "evenimente_urmatoare",
      "Listează evenimentele din echipă în următoarele N zile (implicit 14).",
      { zile: z.number().int().positive().optional() },
      safe(({ zile }) => {
        const days = zile || 14;
        const from = new Date().toISOString();
        const to = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
        return format.formatEvents(eventsSvc.list(actor, { from, to }));
      })
    ),

    tool(
      "prezenta",
      "Statistici de prezență pentru un membru (propria prezență, sau a altuia dacă ai acces OVERSIGHT).",
      { membru_id: z.number().int().optional().describe("Implicit: cel care scrie") },
      safe(({ membru_id }) => format.formatAttendance(attendanceSvc.statsFor(actor, membru_id || actor.id)))
    ),

    tool(
      "cere_motivare_absenta",
      "Înregistrează o cerere de motivare a unei absențe, pentru cel care scrie.",
      {
        sesiune_id: z.number().int().optional(),
        data: z.string().optional().describe("YYYY-MM-DD, dacă nu există sesiune_id"),
        motiv: z.string().optional().describe("Motivul absenței (obligatoriu, cere-l dacă lipsește)"),
      },
      safe(({ sesiune_id, data, motiv }) => {
        const r = absencesSvc.create(actor, { session_id: sesiune_id, date: data, reason: motiv });
        if (r.ulterioara) return "Cerere înregistrată ulterior ședinței (în maximum 48 de ore, Art. 21.1) — decizia rămâne la MANAGERS.";
        return r.tardiva
          ? "Cerere înregistrată, dar e târzie (sub termenul minim) — decizia rămâne la MANAGERS."
          : "Cerere de motivare înregistrată, în termen.";
      })
    ),

    tool(
      "decide_motivare",
      "Aprobă sau respinge o cerere de motivare a absenței (doar MANAGERS).",
      { id: z.number().int(), status: z.enum(["aprobata", "respinsa"]), nota: z.string().optional() },
      safe(({ id, status, nota }) => {
        const r = absencesSvc.decide(actor, id, status, nota);
        return `Cerere #${r.id}: ${r.status}.`;
      })
    ),

    tool(
      "creeaza_reminder",
      "Creează un reminder = un task cu oră de reminder: la ora respectivă vine notificare în platformă + WhatsApp, o singură dată. Dacă membru_id/membru_telefon lipsesc, e pentru cel care scrie. Pentru alt membru necesită rol de MANAGER, iar acel membru trebuie să fie activ. NU acceptă un telefon care nu aparține unui membru din sistem.",
      {
        mesaj: z.string().min(1).describe("Ce trebuie amintit (devine titlul taskului)"),
        cand: z.string().describe("Data/ora locală Europe/Bucharest, format YYYY-MM-DDTHH:MM"),
        membru_id: z.number().int().optional(),
        membru_telefon: z.string().optional().describe("Alternativă la membru_id - telefonul membrului țintă"),
      },
      safe(({ mesaj, cand, membru_id, membru_telefon }) => {
        let targetId = membru_id;
        if (!targetId && membru_telefon) {
          const target = resolveMemberByPhone(membru_telefon);
          if (!target) throw new DomainError("NOT_FOUND", "Membru negăsit.");
          targetId = target.id;
        }
        const r = remindersSvc.create(actor, { target_member_id: targetId, message: mesaj, remind_at: cand });
        return `Reminder creat: „${r.message}” pe ${format.formatLocalDateTime(r.remind_at)} (apare la Taskuri).`;
      })
    ),

    tool(
      "documentele_mele",
      "Documentele cerute celui care scrie, cu statusul fiecăruia, cine semnează și pașii exacți de depunere în platformă. Folosește-l la orice întrebare despre documente, acorduri, semnături sau GDPR.",
      {},
      safe(() => format.formatDocuments(documentsSvc.myStatus(actor, actor.id)))
    ),

    tool(
      "documente_lipsa_echipa",
      "Matrice membri × documente lipsă (doar LEADERS).",
      {},
      safe(() => format.formatMissingDocuments(documentsSvc.matrix(actor)))
    ),

    tool(
      "cauta_membru",
      "Caută un membru după nume (sau parte din nume). Returnează câmpuri publice (nume, rol, departament, status).",
      { query: z.string().min(1) },
      safe(({ query }) => {
        const q = stripDiacritics(query);
        const matches = membersSvc.listDirectory(actor).filter((m) => stripDiacritics(m.name).includes(q));
        if (!matches.length) return "Niciun membru găsit.";
        return matches.map((m) => `#${m.id} ${format.formatMember(m)}`).join("\n");
      })
    ),

    tool(
      "cauta_regulament",
      "Caută în Regulamentul intern. Returnează articolele potrivite, text exact + număr articol.",
      { intrebare: z.string().min(1) },
      safe(({ intrebare }) => format.formatArticles(regulamentSvc.searchFor(actor, intrebare)))
    ),

    tool(
      "cauta_manual_ftc",
      "Caută în manualele oficiale FTC (Competition Manual, Regulament Nație prin Educație, Award Descriptions, " +
        "listele de verificare pentru inspecție robot/teren). Returnează secțiunile/regulile potrivite cu numărul " +
        "regulii sau al secțiunii + documentul sursă, pentru citare exactă. Caută în ENGLEZĂ pentru Competition " +
        "Manual (textul original e în engleză) — ex. \"robot size starting configuration\" nu \"dimensiune robot\".",
      { intrebare: z.string().min(1) },
      safe(({ intrebare }) => format.formatFtcSections(ftcDocsSvc.searchFor(actor, intrebare)))
    ),

    tool(
      "trimite_whatsapp",
      "Trimite un mesaj WhatsApp în numele echipei către un alt membru/număr (doar LEADERS). NU trimite direct — creează o cerere de confirmare; execuția are loc doar după ce cel care scrie răspunde \"DA\" în 10 minute.",
      { catre_telefon: z.string().min(1), mesaj: z.string().min(1) },
      safe(({ catre_telefon, mesaj }) => {
        assertCan(actor, "whatsapp.send", null, "Doar Team Leader sau Co-Leader pot trimite mesaje WhatsApp în numele echipei.");
        const digits = normalizePhone(catre_telefon);
        if (!digits) throw new DomainError("INVALID", "Telefon invalid.");
        const scopeChatId = chatId || `${channel || "web"}:${actor.id}`;
        pending.create(actor, scopeChatId, { to: digits, message: mesaj });
        return `Pregătit de trimis către ${digits}: "${mesaj}". Confirmi? Răspunde DA în 10 minute.`;
      })
    ),
  ];

  // Faza 2 modules each own a tools-<module>.js file (avoids edit conflicts, same rules apply).
  const ctx = { tool, z, safe, actor, channel, chatId };
  for (const mod of ["meetings", "photos", "onboarding", "announcements", "registration", "assignments", "resources"]) {
    tools.push(...require(`./tools-${mod}`).build(ctx));
  }

  return isGroup ? tools.filter((t) => GROUP_PUBLIC_TOOLS.includes(t.name)) : tools;
}

// Wraps buildToolList into an actual in-process MCP server for query().
async function buildToolServer(ctx) {
  const { createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const tools = await buildToolList(ctx);
  return createSdkMcpServer({ name: "crocoai", version: "1.0.0", tools });
}

module.exports = { buildToolList, buildToolServer, resolveMemberByPhone, WRITE_TOOLS };
