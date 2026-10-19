// AI tools for the photos module (design-phase2.md §5). Same rule as tools.js: thin wrappers over
// the domain services with `actor` bound; no business logic here.
const photosSvc = require("../services/photos");

function formatConsent(c) {
  const lines = [c.approved ? "Acord foto/video: aprobat." : "Acord foto/video: lipsește sau neaprobat încă."];
  if (c.withdrawn) lines.push("Acordul a fost RETRAS (Art. 59.3) - nu se mai publică poze noi cu tine.");
  lines.push(c.message);
  if (!c.approved || c.withdrawn) {
    const g = require("../domain/rules").documentGuidance("anexa13_foto_video", c.minor);
    lines.push(`Cum îl dai: Anexa 13. ${g.who_signs} ${g.steps}`);
  }
  return lines.join("\n");
}

function formatPhotoList(list) {
  if (!list.length) return "Nicio poză găsită.";
  return list.map((p) => `#${p.id} (album #${p.album_id}, ${p.uploaded_at}) — ${p.publication.publishable ? "publicabilă" : "nepublicabilă: " + p.publication.message}`).join("\n");
}

// build({ tool, z, safe, actor, channel, chatId }) -> array of tool definitions
function build({ tool, z, safe, actor }) {
  return [
    tool(
      "acordul_meu_foto",
      "Statusul acordului foto/video (Anexa 13, Art. 59) al celui care scrie ȘI procedura exactă de a-l da (cine semnează, pașii din platformă). Folosește-l la orice întrebare despre acordul foto/poze.",
      {},
      safe(() => formatConsent(photosSvc.myConsentStatus(actor)))
    ),

    tool(
      "pozele_mele",
      "Listează pozele în care este etichetat cel care scrie, cu statusul de publicare al fiecăreia.",
      {},
      safe(() => formatPhotoList(photosSvc.photosOf(actor, actor.id)))
    ),

    tool(
      "poze_nepublicabile",
      "Listează pozele care NU pot fi publicate acum, pentru că lipsește acordul foto/video al cel puțin unui membru etichetat (doar LEADERS, Art. 59).",
      {},
      safe(() => formatPhotoList(photosSvc.unpublishable(actor)))
    ),
  ];
}

module.exports = { build };
