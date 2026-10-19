// AI tools for announcements (design-pachet-b.md B1/B2). Thin wrapper over services/announcements with
// `actor` bound: the model sees exactly the announcements the platform shows this member.
const announcementsSvc = require("../services/announcements");
const { formatDateTime } = require("./format");

// build({ tool, z, safe, actor }) -> array of tool definitions
function build({ tool, z, safe, actor }) {
  return [
    tool(
      "anunturi_recente",
      "Listează ultimele anunțuri ale echipei pe care le poate vedea cel care scrie (Art. 23.1): titlu, text, autor, dată.",
      { numar: z.number().int().positive().optional().describe("Câte anunțuri, implicit 10") },
      safe(({ numar }) => {
        const list = announcementsSvc.list(actor, { limit: numar || 10 });
        if (!list.length) return "Niciun anunț momentan.";
        return list.map((a) => `- [${formatDateTime(a.created_at)}] ${a.title}${a.audience === "echipa" ? "" : ` (${a.audience_label})`} — ${a.author_name}${a.body ? `: ${a.body}` : ""}`).join("\n");
      })
    ),
  ];
}

module.exports = { build };
