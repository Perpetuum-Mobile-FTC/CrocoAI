// The team this installation belongs to - the ONE file another team edits to make the platform theirs (open source).
// Used by the public pages (server-side templating in src/pages.js), the PWA manifest, the profile rules and the
// messages the bot sends. Pure module (no db).
const TEAM = {
  name: "Perpetuum Mobile",
  number: "17870", // FTC team number
  // Schools offered on /inscriere; "Altă școală" (free text) is always added after them.
  schools: ["CN Mihai Eminescu", "CN Ioan Slavici"],
  // A school whose students must register with their school email domain (validation + hint on /inscriere).
  schoolEmailDomains: { "CN Mihai Eminescu": "@eminescusm.ro" },
  // Public URL used in links sent on WhatsApp when APP_BASE_URL is not set.
  url: "https://crocoai.perpetuummobile.tech",
};

const baseUrl = () => (process.env.APP_BASE_URL || TEAM.url).replace(/\/+$/, "");

module.exports = { TEAM, baseUrl };
