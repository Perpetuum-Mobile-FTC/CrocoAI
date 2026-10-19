// AI tools for the onboarding module (design-phase2.md §6). Same rule as tools.js: thin wrappers over the
// domain services with `actor` bound; no business logic here.
const onboardingSvc = require("../services/onboarding");

// build({ tool, z, safe, actor, channel, chatId }) -> array of tool definitions
function build({ tool, z, safe, actor }) {
  return [
    tool(
      "stare_onboarding",
      "Pentru MANAGERS: listează voluntarii în proces de integrare, ce le lipsește din checklist și care sunt depășiți de termenul de 30 de zile (Art. 43.3).",
      {},
      safe(() => {
        const rows = onboardingSvc.list(actor);
        if (!rows.length) return "Niciun proces de integrare înregistrat.";
        return rows.map((r) => {
          const missing = r.checklist.filter((c) => !c.done).map((c) => c.label);
          const status = r.status === "complet" ? "complet" : r.overdue ? "DEPĂȘIT (peste 30 zile)" : "în curs";
          return `- ${r.member_name} (${r.department || "fără departament"}): ${status}${missing.length ? ` — lipsește: ${missing.join(", ")}` : ""}`;
        }).join("\n");
      })
    ),
  ];
}

module.exports = { build };
