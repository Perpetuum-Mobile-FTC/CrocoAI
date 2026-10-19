// Decides whether CrocoAI owns an incoming WhatsApp message, per the ownership rules:
// - group message: always logged/handled; reply only if mentioned or replying to our own message, and
//   only to an activ/pauza member (A4: ex-members, alumni and strangers can't use the bot in groups)
// - private from OWNER_PHONE: handled only if text starts with "croco" (prefix stripped)
// - private from an active/onboarding member: handled, reply
// - anyone else: not handled (forwarded to LUCID)
function decideOwnership({ from, text, isGroup, mentioned, quotedFromMe, member, ownerPhone }) {
  if (isGroup) {
    const canUse = !!member && (member.status === "activ" || member.status === "pauza");
    return { handled: true, shouldReply: !!(mentioned || quotedFromMe) && canUse, text };
  }

  if (from === ownerPhone) {
    const trimmed = (text || "").trim();
    const match = trimmed.match(/^@?croco(?:ai)?(?![a-z0-9])[,:!.]?\s*/i);
    if (match) return { handled: true, shouldReply: true, text: trimmed.slice(match[0].length) };
    return { handled: false, shouldReply: false, text };
  }

  if (member && (member.status === "activ" || member.status === "pauza" || member.onboarding_step > 0)) {
    return { handled: true, shouldReply: true, text };
  }

  return { handled: false, shouldReply: false, text };
}

module.exports = { decideOwnership };
