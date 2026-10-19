// Resurse: shared library of files and links by category (docs/api-resurse.md).
// Files are stored at data/resources/<uuid>.<ext> and served only through the authorized endpoint.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const { RESOURCE_CATEGORIES, RESOURCE_MAX_FILE_SIZE } = require("../domain/rules");
const { originalName } = require("./assignment-files");

const root = () => path.resolve(process.env.RESOURCES_DIR || path.join(__dirname, "..", "..", "data", "resources"));
const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function listCategories() {
  return RESOURCE_CATEGORIES.map((c) => ({ ...c }));
}

// Lowercase + strip diacritics (ș/ş/ț/ţ/ă/â/î ...) so searches match regardless of typing.
function fold(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function present(r) {
  return {
    id: r.id,
    category: r.category,
    title: r.title,
    description: r.description,
    kind: r.kind,
    url: r.kind === "link" ? r.url : null,
    file: r.kind === "file" ? { name: r.file_name, mime: r.file_mime, size: r.file_size } : null,
    created_by_name: r.created_by_name || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    sort_order: r.sort_order,
  };
}

const SELECT = "SELECT r.*, m.full_name AS created_by_name FROM resources r LEFT JOIN members m ON m.id = r.created_by";

function row(id) {
  const r = db.prepare(`${SELECT} WHERE r.id = ?`).get(Number(id));
  if (!r) throw new DomainError("NOT_FOUND", "Resursă negăsită.");
  return r;
}

function list(actor, { q, category } = {}) {
  assertCan(actor, "resources.view");
  const order = (c) => { const i = RESOURCE_CATEGORIES.findIndex((x) => x.key === c); return i < 0 ? 999 : i; };
  let rows = db.prepare(`${SELECT}`).all();
  if (category) rows = rows.filter((r) => r.category === category);
  // Every word must appear somewhere (title, description, file name or category label).
  const words = fold(q).split(/\s+/).filter(Boolean);
  const label = (c) => (RESOURCE_CATEGORIES.find((x) => x.key === c) || {}).label;
  if (words.length) rows = rows.filter((r) => {
    const hay = fold(`${r.title} ${r.description} ${r.file_name} ${label(r.category)}`);
    return words.every((w) => hay.includes(w));
  });
  rows.sort((a, b) => order(a.category) - order(b.category) || a.sort_order - b.sort_order || fold(a.title).localeCompare(fold(b.title)));
  return rows.map(present);
}

function get(actor, id) {
  assertCan(actor, "resources.view");
  return present(row(id));
}

function cleanCategory(category) {
  if (!RESOURCE_CATEGORIES.some((c) => c.key === category)) throw new DomainError("INVALID", "Categorie invalidă.");
  return category;
}

function cleanTitle(title) {
  const t = String(title || "").trim();
  if (!t) throw new DomainError("INVALID", "Titlul este obligatoriu.");
  if (t.length > 200) throw new DomainError("INVALID", "Titlul poate avea maxim 200 de caractere.");
  return t;
}

function cleanDescription(d) {
  const s = String(d || "").trim();
  if (s.length > 2000) throw new DomainError("INVALID", "Descrierea poate avea maxim 2000 de caractere.");
  return s || null;
}

function cleanUrl(url) {
  const s = String(url || "").trim();
  let u;
  try { u = new URL(s); } catch { throw new DomainError("INVALID", "Link invalid (trebuie să înceapă cu http:// sau https://)."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new DomainError("INVALID", "Link invalid (trebuie să înceapă cu http:// sau https://).");
  return s.slice(0, 2000);
}

function absPath(stored) {
  const abs = path.resolve(root(), String(stored || ""));
  if (!abs.startsWith(root() + path.sep)) throw new DomainError("NOT_FOUND", "Fișier negăsit.");
  return abs;
}

function checkFile(file) {
  if (!file || !file.buffer) throw new DomainError("INVALID", "Fișier lipsă.");
  if (file.size > RESOURCE_MAX_FILE_SIZE) throw new DomainError("INVALID", `Fișier prea mare (max ${RESOURCE_MAX_FILE_SIZE / 1024 / 1024} MB).`);
}

function store(file) {
  const name = originalName(file);
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const stored = crypto.randomUUID() + ext;
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(absPath(stored), file.buffer);
  return { name, stored, mime: file.mimetype || "application/octet-stream", size: file.size };
}

function unlink(stored) {
  if (!stored) return;
  try { fs.unlinkSync(absPath(stored)); } catch {}
}

function createLink(actor, { category, title, description, url } = {}) {
  assertCan(actor, "resources.manage");
  const vals = [cleanCategory(category), cleanTitle(title), cleanDescription(description), cleanUrl(url)];
  const id = db.prepare("INSERT INTO resources (category, title, description, kind, url, created_by) VALUES (?, ?, ?, 'link', ?, ?)")
    .run(...vals, actor.id).lastInsertRowid;
  return present(row(id));
}

function createFile(actor, { category, title, description } = {}, file) {
  assertCan(actor, "resources.manage");
  cleanCategory(category);
  checkFile(file);
  const name = originalName(file);
  const finalTitle = cleanTitle(String(title || "").trim() || path.parse(name).name);
  const desc = cleanDescription(description);
  const f = store(file);
  const id = db.prepare(`INSERT INTO resources (category, title, description, kind, file_name, file_mime, file_size, stored_name, created_by)
    VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?)`).run(category, finalTitle, desc, f.name, f.mime, f.size, f.stored, actor.id).lastInsertRowid;
  return present(row(id));
}

function update(actor, id, patch = {}) {
  assertCan(actor, "resources.manage");
  const r = row(id);
  const sets = [];
  const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if (patch.category !== undefined) set("category", cleanCategory(patch.category));
  if (patch.title !== undefined) set("title", cleanTitle(patch.title));
  if (patch.description !== undefined) set("description", cleanDescription(patch.description));
  if (patch.url !== undefined) {
    if (r.kind !== "link") throw new DomainError("INVALID", "Doar linkurile au adresă (url).");
    set("url", cleanUrl(patch.url));
  }
  if (patch.sort_order !== undefined) {
    const n = Number(patch.sort_order);
    if (!Number.isInteger(n)) throw new DomainError("INVALID", "Ordinea trebuie să fie un număr întreg.");
    set("sort_order", n);
  }
  if (sets.length) db.prepare(`UPDATE resources SET ${sets.join(", ")}, updated_at = ${stamp} WHERE id = ?`).run(...vals, r.id);
  return present(row(r.id));
}

function replaceFile(actor, id, file) {
  assertCan(actor, "resources.manage");
  const r = row(id);
  if (r.kind !== "file") throw new DomainError("INVALID", "Doar resursele de tip fișier pot primi un fișier nou.");
  checkFile(file);
  const f = store(file);
  db.prepare(`UPDATE resources SET file_name = ?, file_mime = ?, file_size = ?, stored_name = ?, updated_at = ${stamp} WHERE id = ?`)
    .run(f.name, f.mime, f.size, f.stored, r.id);
  unlink(r.stored_name);
  return present(row(r.id));
}

function remove(actor, id) {
  assertCan(actor, "resources.manage");
  const r = row(id);
  db.prepare("DELETE FROM resources WHERE id = ?").run(r.id);
  unlink(r.stored_name);
}

function openFile(actor, id) {
  assertCan(actor, "resources.view");
  const r = row(id);
  if (r.kind !== "file") throw new DomainError("INVALID", "Resursa este un link, nu un fișier.");
  const p = absPath(r.stored_name);
  if (!fs.existsSync(p)) throw new DomainError("NOT_FOUND", "Fișier negăsit pe disc.");
  return { path: p, name: r.file_name, mime: r.file_mime || "application/octet-stream" };
}

const canManage = (actor) => can(actor, "resources.manage");

module.exports = { listCategories, list, get, createLink, createFile, update, replaceFile, remove, openFile, canManage, fold };
