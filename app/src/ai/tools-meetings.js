// AI tools for the meetings module (design-phase2.md §4). Same rule as tools.js: thin wrappers
// over the SAME domain service calls the HTTP routes use (routes/meetings.js) - no business
// logic here. `actor` is bound into every tool's closure by tools.js.
const meetingsSvc = require("../services/meetings");

function build({ tool, z, safe, actor }) {
  return [
    tool(
      "ultimul_proces_verbal",
      "Returnează cel mai recent proces verbal APROBAT al echipei (dată, decizii, acțiuni).",
      {},
      safe(() => {
        const m = meetingsSvc.lastApproved(actor);
        if (!m) return "Nu există încă niciun proces verbal aprobat.";
        const decisions = (m.draft && m.draft.discussions || []).filter((d) => d.decision);
        const lines = [`PV din ${m.session.date}${m.approved_at ? " (aprobat " + m.approved_at.slice(0, 10) + ")" : ""}:`];
        if (!decisions.length) lines.push("Nicio decizie consemnată.");
        for (const d of decisions) lines.push(`- ${d.decision}${d.majora ? " (decizie majoră, Art. 47.2)" : ""}`);
        return lines.join("\n");
      })
    ),

    tool(
      "cauta_procese_verbale",
      "Caută text în procesele verbale (aprobate; ciornele doar pentru MANAGERS/mentori).",
      { text: z.string().min(1) },
      safe(({ text }) => {
        const results = meetingsSvc.search(actor, text);
        if (!results.length) return "Niciun proces verbal nu conține acest text.";
        return results.map((r) => `- ${r.session_date} (${r.status === "approved" ? "aprobat" : "ciornă"})`).join("\n");
      })
    ),

    tool(
      "deciziile_sedintei",
      "Returnează deciziile consemnate în procesele verbale ale ședințelor dintr-o anumită dată (toate ședințele zilei pe care le poți vedea).",
      { data: z.string().describe("Data ședinței, format YYYY-MM-DD") },
      safe(({ data }) => {
        const { meetings } = meetingsSvc.decisionsFor(actor, data);
        const line = (d) => `- ${d.decision}${d.majora ? " (decizie majoră, Art. 47.2)" : ""}`;
        const parts = meetings.map((m) => ({ m, list: m.decisions.filter((d) => d.decision) })).filter((x) => x.list.length);
        if (!parts.length) return `Nicio decizie consemnată pentru ședința din ${data}.`;
        if (meetings.length === 1) return parts[0].list.map(line).join("\n");
        return parts.map(({ m, list }) => `${m.title}${m.time ? ` (ora ${m.time})` : ""}:\n${list.map(line).join("\n")}`).join("\n\n");
      })
    ),
  ];
}

module.exports = { build };
