// Labels shared by the Membri pages (list, applications, profile), Documente and Grupuri.
export const DEPT_LABELS = { tehnic: "Tehnic", "non-tehnic": "Non-tehnic", ambele: "Ambele" };
export const STATUS_LABELS = { activ: "Activ", pauza: "În pauză", iesit: "Ieșit", alumni: "Alumni" };
export const APPLICATION_STATUS_LABELS = { in_asteptare: "În așteptare", acceptata: "Acceptată", respinsa: "Respinsă" };
export const GUARDIAN_RELATION_LABELS = { mama: "Mamă", tata: "Tată", tutore: "Tutore", altul: "Altul" };
export const DOC_STATUS_LABELS = { lipsa: "Lipsă", incarcat: "Încărcat", aprobat: "Aprobat", respins: "Respins" };
export const TASK_STATUS_LABELS = { pending: "De făcut", done: "Finalizat" };
// Display only: 40712345678 -> "+40 712 345 678" (stored numbers stay digits-only).
export function fmtPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (/^407\d{8}$/.test(d)) return `+40 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return phone ? (d.length > 6 ? `+${d}` : String(phone)) : "";
}
