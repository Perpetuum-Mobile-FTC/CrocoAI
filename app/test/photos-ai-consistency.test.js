// Coherence tests (design v2 §11) for the photos AI tools vs their HTTP routes: same data,
// or the same DomainError message+article, with no network/model calls.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._photos_ai_test.db");
const DOCS_DIR = path.join(__dirname, "._photos_ai_test_documents");
const PHOTOS_DIR = path.join(__dirname, "._photos_ai_test_photos");
process.env.DB_PATH = DB_FILE;
process.env.DOCUMENTS_DIR = DOCS_DIR;
process.env.PHOTOS_DIR = PHOTOS_DIR;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
fs.rmSync(DOCS_DIR, { recursive: true, force: true });
fs.rmSync(PHOTOS_DIR, { recursive: true, force: true });

const { server } = require("../server");
const db = require("../src/db");
const { buildToolList } = require("../src/ai/tools");
const photosSvc = require("../src/services/photos");

let BASE;
let leader, member;

function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function login(phone, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200, `login failed for ${phone}: ${await res.text()}`);
  return cookieFrom(res);
}
async function toolsFor(memberId) {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
  const list = await buildToolList({ actor, channel: "web", chatId: `web:${actor.id}` });
  const byName = {};
  for (const t of list) byName[t.name] = (args) => t.handler(args, {});
  return { actor, tools: byName };
}
function toolText(result) { return result.content[0].text; }
function jpegBytes() { return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 1)]); }

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)
  `);
  leader = insert.run("Leader AI Foto", "ai-leader-foto", "40700003001", "team_leader", "team_leader", hash).lastInsertRowid;
  member = insert.run("Membru AI Foto", "ai-membru-foto", "40700003002", "member", "member", hash).lastInsertRowid;

  for (const id of [leader, member]) {
    const info = db.prepare(`
      INSERT INTO member_documents (member_id, type_key, file_path, original_name, mime, size, status)
      VALUES (?, 'anexa13_foto_video', 'x', 'x.pdf', 'application/pdf', 10, 'aprobat')
    `).run(id);
    db.prepare("UPDATE member_documents SET reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(info.lastInsertRowid);
  }
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(DOCS_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(PHOTOS_DIR, { recursive: true, force: true }); } catch {}
});

test("acordul_meu_foto (tool) matches GET /api/photos/consent/me", async () => {
  const cookie = await login("ai-membru-foto", "test1234");
  const httpRes = await fetch(`${BASE}/api/photos/consent/me`, { headers: { Cookie: cookie } });
  const httpStatus = await httpRes.json();

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.acordul_meu_foto({}));
  assert.match(toolOut, /aprobat/);
  assert.equal(httpStatus.approved, true);
});

test("pozele_mele (tool) lists a photo the member is tagged in, matching its publication state", async () => {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(member);
  const album = photosSvc.createAlbum(actor, { title: "Album AI consistency" });
  const photo = await photosSvc.upload(actor, album.id, { buffer: jpegBytes(), size: 200, mimetype: "image/jpeg", originalname: "x.jpg" });
  photosSvc.tagMember(actor, photo.id, member);

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.pozele_mele({}));
  assert.match(toolOut, new RegExp(`#${photo.id}`));
  assert.match(toolOut, /publicabilă/);

  const httpList = photosSvc.photosOf(actor, member);
  assert.ok(httpList.some((p) => p.id === photo.id && p.publication.publishable));
});

test("poze_nepublicabile (tool): FORBIDDEN for a plain member, matches the route's data for LEADERS", async () => {
  const { tools: memberTools } = await toolsFor(member);
  const forbidden = await memberTools.poze_nepublicabile({});
  assert.equal(forbidden.isError, true);

  const cookie = await login("ai-leader-foto", "test1234");
  const httpRes = await fetch(`${BASE}/api/photos/unpublishable`, { headers: { Cookie: cookie } });
  assert.equal(httpRes.status, 200);
  const httpList = await httpRes.json();

  const { tools: leaderTools } = await toolsFor(leader);
  const toolOut = toolText(await leaderTools.poze_nepublicabile({}));
  if (httpList.length === 0) {
    assert.match(toolOut, /Nicio poză/);
  } else {
    for (const p of httpList) assert.match(toolOut, new RegExp(`#${p.id}`));
  }
});
