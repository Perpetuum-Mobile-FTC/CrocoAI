// Single phone normalizer, used everywhere a phone number enters the system
// (import, admin forms, WhatsApp gateway, login). Design v2 §9.
//
// 07xxxxxxxx        -> 407xxxxxxxx
// +40xxxxxxxxx       -> 40xxxxxxxxx
// 0040xxxxxxxxx      -> 40xxxxxxxxx
// other countries (+..., 00..) -> digits, prefix kept as-is
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).trim().replace(/[^\d+]/g, "");
  if (!digits) return null;

  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);

  if (digits.startsWith("0")) {
    // Local Romanian format: 07xxxxxxxx -> 407xxxxxxxx
    digits = "4" + digits;
  }

  if (!/^\d{8,15}$/.test(digits)) return null;
  return digits;
}

module.exports = { normalizePhone };
