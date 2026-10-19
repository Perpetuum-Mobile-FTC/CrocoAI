// Shared bootstrap for the Teme & Grupuri tests (design-teme-grupuri.md). Call initEnv() BEFORE
// requiring ../server or ../src/db: it points DB/files at throwaway paths and mocks the WA gateway.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

function initEnv(name) {
  const DB_FILE = path.join(__dirname, `._${name}.db`);
  const dirs = ["files", "docs", "photos", "res"].map((d) => path.join(__dirname, `._${name}_${d}`));
  Object.assign(process.env, {
    DB_PATH: DB_FILE,
    ASSIGNMENTS_DIR: dirs[0],
    DOCUMENTS_DIR: dirs[1],
    PHOTOS_DIR: dirs[2],
    RESOURCES_DIR: dirs[3],
    ADMIN_INITIAL_PASSWORD: "admintest123",
    JWT_SECRET: "test-jwt-secret",
    WA_SHARED_SECRET: "test-wa-secret",
    LOGIN_RATE_LIMIT_MAX: "1000",
    WA_GATEWAY_URL: "http://mock-wa-gateway.test",
    WA_QUEUE_DELAY_MS: "1",
  });
  const wipe = () => {
    for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true });
  };
  wipe();

  const waSent = [];
  const notOnWhatsApp = new Set(); // phones the mock /resolve reports as not on WhatsApp
  const gateway = { failSend: false, resolveDown: false, groupsDown: false };
  const realFetch = global.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith(process.env.WA_GATEWAY_URL)) return realFetch(url, opts);
    if (u.includes("/resolve/")) {
      if (gateway.resolveDown) return json({ error: "down" }, 503);
      const phone = decodeURIComponent(u.split("/resolve/")[1]);
      return json({ wid: notOnWhatsApp.has(phone) ? null : `${phone}@c.us` });
    }
    if (u.endsWith("/groups")) return gateway.groupsDown ? json({ error: "down" }, 503) : json([]);
    if (u.endsWith("/send")) {
      if (gateway.failSend) return json({ error: "down" }, 503);
      waSent.push(JSON.parse(opts.body));
    }
    return json({ ok: true });
  };
  return { waSent, notOnWhatsApp, gateway, cleanup: wipe };
}

let counter = 0;
let HASH;
function makeMembers(db, specs) {
  HASH = HASH || bcrypt.hashSync("test1234", 4);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, department, password_hash, must_change_password, phone_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, CASE WHEN ? THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END)
  `);
  const out = {};
  for (const s of specs) {
    counter += 1;
    const phone = `4070099${String(counter).padStart(4, "0")}`;
    const id = insert.run(`Test ${s.key}`, `t-${s.key}-${counter}`, phone, s.role, s.role, s.status || "activ", s.department || "ambele", HASH, s.unverified ? 1 : 0).lastInsertRowid;
    out[s.key] = db.prepare("SELECT * FROM members WHERE id = ?").get(id);
  }
  return out;
}

function actorOf(db, id) {
  return db.prepare("SELECT * FROM members WHERE id = ?").get(id);
}

async function login(base, phone) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password: "test1234" }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${phone}: ${await res.text()}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

module.exports = { initEnv, makeMembers, actorOf, login };
