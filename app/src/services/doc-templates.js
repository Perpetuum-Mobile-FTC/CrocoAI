// Server-rendered printable HTML templates for document_types with source='html-anexa'/'html-form'
// (design v2 §7). Pre-filled with the member's name/class/date; A4 print CSS + auto-print button.
// Annex text is copied verbatim from knowledge/anexe.md (ANEXA 5/6/13).
const { TEAM } = require("../domain/team");
const { DomainError } = require("../domain/errors");
const { isMinor } = require("../domain/rules");

function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const PRINT_CSS = `
  @page { size: A4; margin: 2cm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; line-height: 1.5; max-width: 800px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 1.3em; text-align: center; }
  .meta { margin: 1.5em 0; }
  .field { border-bottom: 1px solid #333; display: inline-block; min-width: 220px; padding: 0 4px; }
  .sig { margin-top: 3em; display: flex; justify-content: space-between; }
  .no-print { margin-bottom: 1.5em; }
  @media print { .no-print { display: none; } }
  ul { padding-left: 1.2em; }
`;

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8"><title>${esc(title)}</title>
  <style>${PRINT_CSS}</style></head><body>
  <div class="no-print"><button type="button" data-print>Printează / salvează PDF</button></div>
  <h1>${esc(title)}</h1>
  ${bodyHtml}
  <script src="/js/print.js"></script>
  </body></html>`;
}

function today() {
  return new Date().toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" });
}

function anexa5(member) {
  return wrap("Anexa 5 — Acord de Confidențialitate", `
    <p class="meta">Data: <span class="field">${esc(today())}</span></p>
    <p>Subsemnatul/a <span class="field">${esc(member.full_name)}</span>, în calitate de <span class="field">${esc(member.role || "")}</span> al echipei de robotică FTC ${esc(TEAM.name)}, mă angajez prin prezentul acord să păstrez confidențialitatea următoarelor informații:</p>
    <ol>
      <li><strong>Strategia de joc</strong> — tactici, abordări și decizii strategice pentru sezonul competițional în curs;</li>
      <li><strong>Designul robotului</strong> — soluții tehnice, configurații mecanice, scheme electronice, cod sursă;</li>
      <li><strong>Date interne</strong> — informații financiare, decizii interne, comunicări private ale echipei;</li>
      <li><strong>Parteneri și sponsori</strong> — termenii acordurilor cu sponsorii și partenerii echipei.</li>
    </ol>
    <p><strong>Mă angajez că:</strong></p>
    <ul>
      <li>Nu voi divulga informațiile de mai sus altor echipe FTC sau persoane neautorizate, pe parcursul sezonului competițional și timp de 12 luni după finalizarea acestuia;</li>
      <li>Nu voi folosi informațiile dobândite în cadrul echipei în beneficiul unei alte echipe;</li>
      <li>Voi notifica imediat Team Leader-ul dacă am cunoștință de o încălcare a confidențialității.</li>
    </ul>
    <p><strong>Excepții:</strong> Informațiile deja publice (postări oficiale aprobate ale echipei, prezentări publice la competiții) nu intră sub incidența prezentului acord.</p>
    <div class="sig"><div>Semnătura: _______________________</div><div>Luat la cunoștință de Team Leader: _______________________</div></div>
  `);
}

function anexa6(member) {
  return wrap("Anexa 6 — Formular Acceptare Regulament", `
    <p class="meta">Data: <span class="field">${esc(today())}</span></p>
    <p>Subsemnatul/a <span class="field">${esc(member.full_name)}</span>, declar că:</p>
    <ol>
      <li>Am citit integral Regulamentul Intern al echipei de robotică FTC ${esc(TEAM.name)}, versiunea 1.0, în vigoare de la data de _______________;</li>
      <li>Am înțeles și accept toate prevederile acestuia;</li>
      <li>Mă angajez să le respect pe toată durata participării mele în echipă.</li>
    </ol>
    <p><strong>Rol în echipă:</strong> <span class="field">${esc(member.role || "")}</span></p>
    <div class="sig"><div>Semnătura: _______________________</div><div>Luat la cunoștință de Team Leader: _______________________</div></div>
  `);
}

function anexa13(member) {
  const minor = isMinor(member.birthdate);
  return wrap("Anexa 13 — Acord de Consimțământ Foto/Video", `
    <p class="meta">Data: <span class="field">${esc(today())}</span></p>
    <p>Subsemnatul/a <span class="field">${esc(member.full_name)}</span>,</p>
    ${minor ? '<p>(pentru minori) Părinte/Tutore al <span class="field">' + esc(member.full_name) + "</span>,</p>" : ""}
    <p>în calitate de <span class="field">${esc(member.role || "")}</span> al echipei de robotică FTC ${esc(TEAM.name)}, îmi exprim acordul cu privire la fotografierea și filmarea în cadrul activităților echipei, în conformitate cu Art. 59 din Regulamentul Intern.</p>
    <p><strong>1. Fotografiere și filmare la activitățile echipei:</strong> □ De acord &nbsp; □ Nu sunt de acord</p>
    <p><strong>2. Publicare pe canalele oficiale ale echipei:</strong> □ De acord — cu identitate vizibilă &nbsp; □ De acord — anonimizat &nbsp; □ Nu sunt de acord</p>
    <p><strong>3. Utilizare în materiale promoționale:</strong> □ De acord &nbsp; □ Nu sunt de acord</p>
    <p>Înțeleg că, la retragerea acordului, echipa șterge la cerere materialele de pe canalele proprii în 14 zile, dar nu poate controla materialele preluate deja de terți;</p>
    <p>Înțeleg că pot retrage prezentul acord oricând, în scris, adresat Team Leader-ului;</p>
    <p>Înțeleg că fotografiile echipei nu se distribuie terților fără aprobarea Team Leader-ului (Art. 59.5).</p>
    <div class="sig"><div>Semnătura titularului: _______________________</div>${minor ? "<div>Semnătura părintelui/tutorelui: _______________________</div>" : ""}</div>
  `);
}

function fisaMedicala(member) {
  return wrap("Fișă medicală sumară", `
    <p class="meta">Membru: <strong>${esc(member.full_name)}</strong> — Data: <span class="field">${esc(today())}</span></p>
    <p><em>Document confidențial, vizibil exclusiv membrului și Team Leader-ului (Art. 58.3).</em></p>
    <p><strong>Condiții medicale relevante:</strong></p><p class="field" style="display:block;min-height:3em;"></p>
    <p><strong>Alergii:</strong></p><p class="field" style="display:block;min-height:2em;"></p>
    <p><strong>Medicație curentă:</strong></p><p class="field" style="display:block;min-height:2em;"></p>
    <p><strong>Persoană de contact de urgență:</strong> nume ____________________ telefon ____________________</p>
    <div class="sig"><div>Semnătura (membru/părinte): _______________________</div></div>
  `);
}

function acordDeplasare(member) {
  return wrap("Acord parental deplasare", `
    <p class="meta">Membru: <strong>${esc(member.full_name)}</strong> — Data: <span class="field">${esc(today())}</span></p>
    <p>Subsemnatul/a, părinte/tutore al <span class="field">${esc(member.full_name)}</span>, îmi exprim acordul pentru participarea acestuia/acesteia la deplasarea echipei la competiție, conform Art. 50.3 din Regulamentul Intern (depus cu minimum 7 zile înainte de deplasare).</p>
    <p><strong>Competiție / eveniment:</strong> ____________________ <strong>Perioadă:</strong> ____________________</p>
    <div class="sig"><div>Semnătura părintelui/tutorelui: _______________________</div></div>
  `);
}

const RENDERERS = {
  anexa5_confidentialitate: anexa5,
  anexa6_regulament: anexa6,
  anexa13_foto_video: anexa13,
  fisa_medicala: fisaMedicala,
  acord_parental_deplasare: acordDeplasare,
};

function render(typeKey, member) {
  const fn = RENDERERS[typeKey];
  if (!fn) throw new DomainError("NOT_FOUND", "Acest tip de document nu are șablon HTML.");
  return fn(member);
}

module.exports = { render, RENDERERS };
