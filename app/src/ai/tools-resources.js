// AI tool for Resurse: read-only wrapper over services/resources with `actor` bound.
const resourcesSvc = require("../services/resources");
const { RESOURCE_CATEGORIES } = require("../domain/rules");

const { baseUrl } = require("../domain/team");
const MAX = 15;

function format(list) {
  if (!list.length) return "Nu am găsit nicio resursă pentru cererea asta în biblioteca echipei.";
  const label = Object.fromEntries(RESOURCE_CATEGORIES.map((c) => [c.key, c.label]));
  const lines = list.slice(0, MAX).map((r) => {
    const where = r.kind === "link" ? r.url : `${baseUrl()}/api/resources/${r.id}/file`;
    return `- ${r.title} [${label[r.category] || r.category}]${r.description ? `: ${r.description}` : ""} → ${where}`;
  });
  if (list.length > MAX) lines.push(`(+${list.length - MAX} resurse; restrânge căutarea)`);
  return lines.join("\n");
}

function build({ tool, z, safe, actor }) {
  return [
    tool(
      "cauta_resurse",
      "Caută în biblioteca Resurse a echipei (fișiere și linkuri puse de conducere): documente, șabloane, ghiduri, contracte, regulamente, linkuri utile. " +
        "Folosește-l când un membru cere un document/șablon/ghid/link (ex. contract de sponsorizare, ghid de comunicare, regulament, resurse de programare/CAD). " +
        `Categorii: ${RESOURCE_CATEGORIES.map((c) => `${c.key} (${c.label})`).join(", ")}. Ambele câmpuri sunt opționale; fără ele listează tot.`,
      { query: z.string().optional(), category: z.string().optional() },
      safe(({ query, category }) => format(resourcesSvc.list(actor, { q: query, category })))
    ),
  ];
}

module.exports = { build };
