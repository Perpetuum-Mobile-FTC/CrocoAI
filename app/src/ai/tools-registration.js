// AI tools for public applications + profile completion (design-formular-date.md §4). Same rule
// as tools.js: thin wrappers over the domain services with `actor` bound; no business logic here.
const profile = require("../domain/profile");
const membersSvc = require("../services/members");
const applicationsSvc = require("../services/applications");

function missingLine(name, missing) {
  return `- ${name}: lipsește ${missing.map((f) => profile.FIELD_LABELS[f] || f).join(", ")}`;
}

// build({ tool, z, safe, actor, channel, chatId }) -> array of tool definitions
function build({ tool, z, safe, actor }) {
  return [
    tool(
      "datele_mele_lipsa",
      "Ce câmpuri lipsesc din profilul celui care scrie și cum le completează.",
      {},
      safe(() => {
        const missing = membersSvc.myMissingFields(actor);
        if (!missing.length) return "Profilul tău este complet.";
        return `Îți lipsesc: ${missing.map((f) => profile.FIELD_LABELS[f] || f).join(", ")}. Le poți completa din Membri → profilul tău → Editează, sau printr-un link de completare primit de la un Team Leader.`;
      })
    ),

    tool(
      "membri_date_incomplete",
      "Pentru LEADERS: membrii cu date de profil incomplete.",
      {},
      safe(() => {
        const list = membersSvc.missingDataList(actor);
        if (!list.length) return "Toți membrii au profilul complet.";
        return list.map((r) => missingLine(r.name, r.missing)).join("\n");
      })
    ),

    tool(
      "cereri_inscriere",
      "Pentru LEADERS: câte cereri de înscriere noi așteaptă decizie.",
      {},
      safe(() => {
        const count = applicationsSvc.pendingCount(actor);
        return count === 0 ? "Nicio cerere de înscriere în așteptare." : `${count} cerere${count === 1 ? "" : "i"} de înscriere în așteptare (Membri → Cereri).`;
      })
    ),
  ];
}

module.exports = { build };
