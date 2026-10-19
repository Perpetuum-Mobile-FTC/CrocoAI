// Static HTML pages + the PWA manifest with the team's identity filled in (src/domain/team.js) - so the
// team-specific text lives in one file. Placeholders: {{TEAM_NAME}}, {{SCHOOL_OPTIONS}}.
const fs = require("fs");
const path = require("path");
const { TEAM } = require("./domain/team");
const { OTHER_SCHOOL } = require("./domain/profile");

const PUBLIC = path.join(__dirname, "..", "public");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function schoolOptions() {
  return [...TEAM.schools, OTHER_SCHOOL].map((s) => {
    const domain = TEAM.schoolEmailDomains[s];
    return `<option value="${esc(s)}"${domain ? ` data-email-domain="${esc(domain)}"` : ""}>${esc(s)}</option>`;
  }).join("\n            ");
}

function fill(text, { json = false } = {}) {
  const name = json ? JSON.stringify(TEAM.name).slice(1, -1) : esc(TEAM.name);
  return text.replace(/\{\{TEAM_NAME\}\}/g, name).replace(/\{\{SCHOOL_OPTIONS\}\}/g, schoolOptions());
}

// file = name inside public/ ("login.html", "manifest.json").
function render(file) {
  return fill(fs.readFileSync(path.join(PUBLIC, file), "utf8"), { json: file.endsWith(".json") });
}

// Public files that carry placeholders: served only through render(), never raw by express.static.
const TEMPLATED = ["/index.html", "/login.html", "/inscriere.html", "/completare.html", "/manifest.json"];

module.exports = { render, fill, TEMPLATED };
