// Members added without a phone (e.g. department heads from migration 003) got no username,
// so they could never log in. Give every such member a unique firstname.lastname username.
// Inline (not services/username): requiring a service here would load ../db while it's still
// initializing (circular require) and leave that service with an empty db export.
function slug(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z\s]/g, "").trim().split(/\s+/).filter(Boolean).join(".");
}

function up(db) {
  const taken = new Set(db.prepare("SELECT username FROM members WHERE username IS NOT NULL").all().map((r) => r.username));
  const missing = db.prepare("SELECT id, full_name FROM members WHERE username IS NULL OR username = ''").all();
  const update = db.prepare("UPDATE members SET username = ? WHERE id = ?");
  for (const m of missing) {
    const base = slug(m.full_name) || `membru${m.id}`;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
    update.run(name, m.id);
  }
}

module.exports = { up };
