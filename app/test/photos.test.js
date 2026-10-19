// Poze cu consimțământ (design-phase2.md §5): permissions, publication logic, consent withdrawal,
// /wa/media guard+storage, want_media hook, type validation.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._photos_test.db");
const DOCS_DIR = path.join(__dirname, "._photos_test_documents");
const PHOTOS_DIR = path.join(__dirname, "._photos_test_photos");
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
const { can } = require("../src/domain/policy");
const { photoPublication } = require("../src/domain/rules");
const photosSvc = require("../src/services/photos");

let BASE;
let leader, coLeader, member, otherMember, minorMember;

function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }

async function login(phone, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200, `login failed for ${phone}: ${await res.text()}`);
  return cookieFrom(res);
}

const sharp = require("sharp");
let REAL_JPEG;

function jpegBytes() {
  return REAL_JPEG;
}

function approveConsent(memberId) {
  const info = db.prepare(`
    INSERT INTO member_documents (member_id, type_key, file_path, original_name, mime, size, status)
    VALUES (?, 'anexa13_foto_video', 'x', 'x.pdf', 'application/pdf', 10, 'incarcat')
  `).run(memberId);
  db.prepare("UPDATE member_documents SET status='aprobat', reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(info.lastInsertRowid);
}

before(async () => {
  REAL_JPEG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer();

  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, birthdate, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, ?, 0)
  `);
  leader = insert.run("Leader Foto", "leader-foto", "40700002001", "team_leader", "team_leader", "1990-01-01", hash).lastInsertRowid;
  coLeader = insert.run("CoLeader Foto", "coleader-foto", "40700002002", "co_leader", "co_leader", "1990-01-01", hash).lastInsertRowid;
  member = insert.run("Membru Foto Unu", "membrufoto1", "40700002003", "member", "member", "2000-01-01", hash).lastInsertRowid;
  otherMember = insert.run("Membru Foto Doi", "membrufoto2", "40700002004", "member", "member", "2000-01-01", hash).lastInsertRowid;
  minorMember = insert.run("Membru Minor Foto", "membrufotominor", "40700002005", "member", "member", "2012-01-01", hash).lastInsertRowid;

  approveConsent(leader);
  approveConsent(coLeader);
  approveConsent(member);
  approveConsent(otherMember);
  approveConsent(minorMember);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  for (const dir of ["backups", DOCS_DIR, PHOTOS_DIR]) { try { fs.rmSync(path.join(__dirname, dir), { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(DOCS_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(PHOTOS_DIR, { recursive: true, force: true }); } catch {}
});

// --- Permissions (design-phase2.md §2) ---
test("photos.view -> active/pauza/alumni, not iesit", () => {
  assert.equal(can({ status: "activ" }, "photos.view"), true);
  assert.equal(can({ status: "pauza" }, "photos.view"), true);
  assert.equal(can({ status: "alumni" }, "photos.view"), true);
  assert.equal(can({ status: "iesit" }, "photos.view"), false);
});
test("photos.upload -> status activ only", () => {
  assert.equal(can({ status: "activ" }, "photos.upload"), true);
  assert.equal(can({ status: "pauza" }, "photos.upload"), false);
});
test("photos.tag_any -> MANAGERS", () => {
  assert.equal(can({ role: "head_tech", status: "activ" }, "photos.tag_any"), true);
  assert.equal(can({ role: "member", status: "activ" }, "photos.tag_any"), false);
});
test("photos.delete_any / photos.publish -> LEADERS", () => {
  assert.equal(can({ role: "co_leader", status: "activ" }, "photos.delete_any"), true);
  assert.equal(can({ role: "head_tech", status: "activ" }, "photos.delete_any"), false);
  assert.equal(can({ role: "team_leader", status: "activ" }, "photos.publish"), true);
  assert.equal(can({ role: "head_tech", status: "activ" }, "photos.publish"), false);
});

// --- Publication logic (rules.photoPublication, Art. 59) ---
test("photoPublication: all approved+not withdrawn -> publishable", () => {
  const r = photoPublication([{ member_id: 1, name: "A", approved: true, withdrawn: false }]);
  assert.equal(r.publishable, true);
});
test("photoPublication: one missing/unapproved consent -> not publishable, names listed", () => {
  const r = photoPublication([
    { member_id: 1, name: "A", approved: true, withdrawn: false },
    { member_id: 2, name: "B (minor)", approved: false, withdrawn: false },
  ]);
  assert.equal(r.publishable, false);
  assert.match(r.message, /B \(minor\)/);
  assert.equal(r.article, "Art. 59.2");
});
test("photoPublication: withdrawn consent (even if previously approved) -> not publishable", () => {
  const r = photoPublication([{ member_id: 1, name: "A", approved: true, withdrawn: true }]);
  assert.equal(r.publishable, false);
});

// --- Service-level: upload, tag, consent, publish ---
test("active member uploads photo to a new album, uploader can tag own photo without MANAGERS", async () => {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(member);
  const album = photosSvc.createAlbum(actor, { title: "Ședință test" });
  const photo = await photosSvc.upload(actor, album.id, {
    buffer: jpegBytes(), size: 200, mimetype: "image/jpeg", originalname: "a.jpg",
  });
  assert.equal(photo.uploaded_by, member);
  assert.ok(photo.thumb_path, "thumbnail should be generated for a JPEG");

  // uploader tags themself without being a manager
  const tagged = photosSvc.tagMember(actor, photo.id, member);
  assert.equal(tagged.tags.length, 1);

  // another plain member (not uploader, not manager) cannot tag
  const otherActor = db.prepare("SELECT * FROM members WHERE id = ?").get(otherMember);
  assert.throws(() => photosSvc.tagMember(otherActor, photo.id, otherMember), /FORBIDDEN|Nu ai permisiunea/);
});

test("photo with all tagged consents approved is publishable; LEADERS can publish it", () => {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(member);
  const leaderActor = db.prepare("SELECT * FROM members WHERE id = ?").get(leader);
  const album = photosSvc.createAlbum(actor, { title: "Album publicabil" });
  return photosSvc.upload(actor, album.id, { buffer: jpegBytes(), size: 200, mimetype: "image/jpeg", originalname: "b.jpg" }).then((photo) => {
    photosSvc.tagMember(actor, photo.id, member);
    const pub = photosSvc.publicationFor(photo.id);
    assert.equal(pub.publishable, true);
    const published = photosSvc.publish(leaderActor, photo.id, true);
    assert.equal(published.published, true);
  });
});

test("consent withdrawal flips existing photos to non-publishable, without touching old photos' rows", async () => {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(otherMember);
  const album = photosSvc.createAlbum(actor, { title: "Album retragere" });
  const photo = await photosSvc.upload(actor, album.id, { buffer: jpegBytes(), size: 200, mimetype: "image/jpeg", originalname: "c.jpg" });
  photosSvc.tagMember(actor, photo.id, otherMember);
  assert.equal(photosSvc.publicationFor(photo.id).publishable, true);

  photosSvc.withdrawConsent(actor);
  const after = photosSvc.publicationFor(photo.id);
  assert.equal(after.publishable, false);
  assert.match(after.message, /Membru Foto Doi/);

  // LEADERS cannot publish a now-nonpublishable photo
  const leaderActor = db.prepare("SELECT * FROM members WHERE id = ?").get(leader);
  assert.throws(() => photosSvc.publish(leaderActor, photo.id, true), /FORBIDDEN|lipsește acordul/);
});

test("minor member without approved consent makes a tagged photo non-publishable (Art. 59.2)", async () => {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(member);
  const minorActor = db.prepare("SELECT * FROM members WHERE id = ?").get(minorMember);
  // revert the minor's seeded consent approval to simulate "not yet signed"
  db.prepare("DELETE FROM member_documents WHERE member_id = ? AND type_key = 'anexa13_foto_video'").run(minorMember);

  const album = photosSvc.createAlbum(actor, { title: "Album minor" });
  const photo = await photosSvc.upload(actor, album.id, { buffer: jpegBytes(), size: 200, mimetype: "image/jpeg", originalname: "d.jpg" });
  photosSvc.tagMember(actor, photo.id, minorMember);
  const pub = photosSvc.publicationFor(photo.id);
  assert.equal(pub.publishable, false);
  assert.match(pub.message, /Membru Minor Foto/);

  approveConsent(minorMember); // restore for later tests
});

// --- Route-level ---
test("route: upload rejects a file with mismatched magic bytes (type validation)", async () => {
  const cookie = await login("membrufoto1", "test1234");
  const album = await (await fetch(`${BASE}/api/photos/albums`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ title: "Album validare" }),
  })).json();

  const form = new FormData();
  form.append("files", new Blob([Buffer.from("not a real jpeg")], { type: "image/jpeg" }), "fake.jpg");
  const res = await fetch(`${BASE}/api/photos/albums/${album.id}/photos`, { method: "POST", headers: { Cookie: cookie }, body: form });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /nu corespunde tipului declarat/);
});

test("route: original download restricted to uploader/LEADERS; thumbnail open to any photos.view member", async () => {
  const cookieUploader = await login("membrufoto1", "test1234");
  const cookieOther = await login("membrufoto2", "test1234");

  const album = await (await fetch(`${BASE}/api/photos/albums`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieUploader },
    body: JSON.stringify({ title: "Album download" }),
  })).json();
  const form = new FormData();
  form.append("files", new Blob([jpegBytes()], { type: "image/jpeg" }), "e.jpg");
  const upRes = await fetch(`${BASE}/api/photos/albums/${album.id}/photos`, { method: "POST", headers: { Cookie: cookieUploader }, body: form });
  const [photo] = await upRes.json();

  const originalOther = await fetch(`${BASE}/api/photos/${photo.id}/file`, { headers: { Cookie: cookieOther } });
  assert.equal(originalOther.status, 403);
  const originalOwner = await fetch(`${BASE}/api/photos/${photo.id}/file`, { headers: { Cookie: cookieUploader } });
  assert.equal(originalOwner.status, 200);
  const thumbOther = await fetch(`${BASE}/api/photos/${photo.id}/thumb`, { headers: { Cookie: cookieOther } });
  assert.equal(thumbOther.status, 200);
});

test("route: delete - owner can delete own photo, plain member cannot delete another's", async () => {
  const cookieUploader = await login("membrufoto1", "test1234");
  const cookieOther = await login("membrufoto2", "test1234");
  const album = await (await fetch(`${BASE}/api/photos/albums`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieUploader },
    body: JSON.stringify({ title: "Album delete" }),
  })).json();
  const form = new FormData();
  form.append("files", new Blob([jpegBytes()], { type: "image/jpeg" }), "f.jpg");
  const upRes = await fetch(`${BASE}/api/photos/albums/${album.id}/photos`, { method: "POST", headers: { Cookie: cookieUploader }, body: form });
  const [photo] = await upRes.json();

  const forbidden = await fetch(`${BASE}/api/photos/${photo.id}`, { method: "DELETE", headers: { Cookie: cookieOther } });
  assert.equal(forbidden.status, 403);
  const ok = await fetch(`${BASE}/api/photos/${photo.id}`, { method: "DELETE", headers: { Cookie: cookieUploader } });
  assert.equal(ok.status, 200);
});

test("route: consent/withdraw then consent/me reflects the change", async () => {
  const cookie = await login("leader-foto", "test1234");
  const before = await (await fetch(`${BASE}/api/photos/consent/me`, { headers: { Cookie: cookie } })).json();
  assert.equal(before.approved, true);
  assert.equal(before.withdrawn, false);

  const wd = await fetch(`${BASE}/api/photos/consent/withdraw`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(wd.status, 200);

  const after = await (await fetch(`${BASE}/api/photos/consent/me`, { headers: { Cookie: cookie } })).json();
  assert.equal(after.withdrawn, true);
  assert.equal(after.publishable, false);

  approveConsent(leader); // restore (inserts a newer approval after the withdrawal timestamp)
});

// --- /wa/media guard + storage, untracked group rejected ---
test("/wa/media: wrong shared secret -> 403", async () => {
  const res = await fetch(`${BASE}/wa/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": "wrong" },
    body: JSON.stringify({ msgId: "wm1", groupId: "g@g.us", mediaType: "image", mimetype: "image/jpeg", data: jpegBytes().toString("base64") }),
  });
  assert.equal(res.status, 403);
});

test("/wa/media: cf-connecting-ip header present -> 403 (not reachable through the public tunnel)", async () => {
  const res = await fetch(`${BASE}/wa/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET, "cf-connecting-ip": "1.2.3.4" },
    body: JSON.stringify({ msgId: "wm2", groupId: "g@g.us", mediaType: "image", mimetype: "image/jpeg", data: jpegBytes().toString("base64") }),
  });
  assert.equal(res.status, 403);
});

test("/wa/media: untracked group is rejected", async () => {
  const res = await fetch(`${BASE}/wa/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "wm3", groupId: "untracked-media@g.us", mediaType: "image", mimetype: "image/jpeg", data: jpegBytes().toString("base64") }),
  });
  assert.equal(res.status, 403);
});

test("/wa/media: tracked group stores the photo into a monthly album, attributed to the sender if known", async () => {
  db.prepare("INSERT INTO wa_groups (group_id, name, tracked) VALUES ('tracked-media@g.us', 'Grup Poze', 1)").run();
  const res = await fetch(`${BASE}/wa/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({
      msgId: "wm4", from: "40700002003", groupId: "tracked-media@g.us", groupName: "Grup Poze",
      mediaType: "image", mimetype: "image/jpeg", filename: "wa.jpg", data: jpegBytes().toString("base64"),
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.stored, true);

  const photo = db.prepare("SELECT * FROM photos WHERE id = ?").get(body.photo_id);
  assert.equal(photo.uploaded_by, member); // sender resolved to the member with that phone
  assert.equal(photo.source, "whatsapp");

  const album = db.prepare("SELECT * FROM albums WHERE id = ?").get(body.album_id);
  assert.equal(album.wa_group_id, "tracked-media@g.us");

  // idempotent on msgId
  const res2 = await fetch(`${BASE}/wa/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({
      msgId: "wm4", from: "40700002003", groupId: "tracked-media@g.us", groupName: "Grup Poze",
      mediaType: "image", mimetype: "image/jpeg", filename: "wa.jpg", data: jpegBytes().toString("base64"),
    }),
  });
  const body2 = await res2.json();
  assert.equal(body2.stored, false);
});

// --- want_media hook on /wa/incoming ---
test("want_media: true only for tracked groups with image/video media, absent otherwise", async () => {
  db.prepare("INSERT INTO wa_groups (group_id, name, tracked) VALUES ('tracked-wm@g.us', 'Grup WM', 1)").run();

  const withMedia = await fetch(`${BASE}/wa/incoming`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "im1", isGroup: true, groupId: "tracked-wm@g.us", groupName: "Grup WM", hasMedia: true, mediaType: "image" }),
  });
  const bodyMedia = await withMedia.json();
  assert.equal(bodyMedia.want_media, true);

  const textOnly = await fetch(`${BASE}/wa/incoming`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "im2", isGroup: true, groupId: "tracked-wm@g.us", groupName: "Grup WM", text: "salut" }),
  });
  const bodyText = await textOnly.json();
  assert.equal(bodyText.want_media, undefined);

  const docMedia = await fetch(`${BASE}/wa/incoming`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "im3", isGroup: true, groupId: "tracked-wm@g.us", groupName: "Grup WM", hasMedia: true, mediaType: "document" }),
  });
  const bodyDoc = await docMedia.json();
  assert.equal(bodyDoc.want_media, undefined);

  // untracked group never asks for media, even with image attached
  const untracked = await fetch(`${BASE}/wa/incoming`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "im4", isGroup: true, groupId: "untracked-wm@g.us", groupName: "Grup Netrackuit", hasMedia: true, mediaType: "image" }),
  });
  const bodyUntracked = await untracked.json();
  assert.equal(bodyUntracked.want_media, undefined);
});

test("media-only group message (hasMedia, no text) is not logged as triggering the AI reply path", async () => {
  const before = db.prepare("SELECT COUNT(*) c FROM messages WHERE from_me = 1").get().c;
  const res = await fetch(`${BASE}/wa/incoming`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "im5", isGroup: true, groupId: "tracked-wm@g.us", groupName: "Grup WM", hasMedia: true, mediaType: "image", mentioned: true }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150)); // let any (incorrect) async reply settle
  const after = db.prepare("SELECT COUNT(*) c FROM messages WHERE from_me = 1").get().c;
  assert.equal(after, before, "no bot reply should have been sent for a media-only message");
});
