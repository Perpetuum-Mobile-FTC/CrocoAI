// Resurse: policy, service, routes (docs/api-resurse.md) + AI tool parity.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("resources");
const { server } = require("../server");
const db = require("../src/db");
const { can } = require("../src/domain/policy");
const resources = require("../src/services/resources");
const { buildToolList } = require("../src/ai/tools");

let M, BASE;
const cookies = {};
const file = (name, content = "hello", mimetype = "application/pdf") => ({ buffer: Buffer.from(content), size: Buffer.byteLength(content), originalname: name, mimetype });
const onDisk = () => (fs.existsSync(process.env.RESOURCES_DIR) ? fs.readdirSync(process.env.RESOURCES_DIR) : []);
async function api(who, method, url, body) {
  const headers = { Cookie: cookies[who] };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  return fetch(`${BASE}${url}`, { method, headers, body: payload });
}
function form(fields, f) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (f) fd.append("file", new Blob([f.content], { type: f.name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream" }), f.name);
  return fd;
}

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "m", role: "member" }, { key: "tl", role: "team_leader" }, { key: "co", role: "co_leader" },
    { key: "ht", role: "head_tech" }, { key: "hn", role: "head_nontech" }, { key: "me", role: "mentor" },
    { key: "out", role: "member", status: "iesit" }, { key: "al", role: "member", status: "alumni" },
  ]);
  for (const k of ["m", "tl", "ht", "me", "al"]) cookies[k] = await login(BASE, M[k].phone);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

test("policy: everyone active/alumni/oversight views, only active oversight manages", () => {
  for (const k of ["m", "tl", "co", "ht", "hn", "me", "al"]) assert.equal(can(M[k], "resources.view"), true, k);
  assert.equal(can(M.out, "resources.view"), false);
  for (const k of ["tl", "co", "ht", "hn", "me"]) assert.equal(can(M[k], "resources.manage"), true, k);
  for (const k of ["m", "al", "out"]) assert.equal(can(M[k], "resources.manage"), false, k);
  assert.equal(can({ ...M.tl, status: "pauza" }, "resources.manage"), false);
  assert.equal(can({ ...M.tl, status: "iesit" }, "resources.manage"), false);
});

test("service: validation of category, title and url", () => {
  const ok = { category: "pr", title: "Ghid", url: "https://example.com/x" };
  assert.throws(() => resources.createLink(M.m, ok), { code: "FORBIDDEN" });
  assert.throws(() => resources.createLink(M.tl, { ...ok, category: "nope" }), { code: "INVALID" });
  assert.throws(() => resources.createLink(M.tl, { ...ok, title: "  " }), { code: "INVALID" });
  assert.throws(() => resources.createLink(M.tl, { ...ok, title: "x".repeat(201) }), { code: "INVALID" });
  for (const url of ["javascript:alert(1)", "ftp://x.ro/a", "nu e link", ""]) assert.throws(() => resources.createLink(M.tl, { ...ok, url }), { code: "INVALID" }, url);
  const r = resources.createLink(M.ht, ok);
  assert.equal(r.kind, "link");
  assert.equal(r.url, ok.url);
  assert.equal(r.file, null);
  assert.equal(r.created_by_name, M.ht.full_name);
  assert.throws(() => resources.get({ ...M.m, status: "iesit" }, r.id), { code: "FORBIDDEN" });
  assert.throws(() => resources.get(M.m, 99999), { code: "NOT_FOUND" });
});

test("service: file lifecycle (create, title default, replace, remove) touches disk", () => {
  const before = onDisk().length;
  const r = resources.createFile(M.me, { category: "regulamente", title: "", description: "d" }, file("Regulament șah.pdf"));
  assert.equal(r.title, "Regulament șah");
  assert.equal(r.file.name, "Regulament șah.pdf");
  assert.equal(onDisk().length, before + 1);
  assert.throws(() => resources.update(M.me, r.id, { url: "https://a.ro" }), { code: "INVALID" });
  const stored = db.prepare("SELECT stored_name FROM resources WHERE id=?").get(r.id).stored_name;
  const r2 = resources.replaceFile(M.me, r.id, file("nou.pdf", "alt continut"));
  assert.equal(r2.file.name, "nou.pdf");
  assert.equal(onDisk().length, before + 1);
  assert.ok(!onDisk().includes(stored));
  resources.remove(M.me, r.id);
  assert.equal(onDisk().length, before);
  assert.throws(() => resources.get(M.me, r.id), { code: "NOT_FOUND" });
  assert.throws(() => resources.createFile(M.m, { category: "pr" }, file("a.pdf")), { code: "FORBIDDEN" });
  assert.throws(() => resources.createFile(M.tl, { category: "pr" }, null), { code: "INVALID" });
});

test("service: search is case and diacritics insensitive, ordered by category", () => {
  resources.createLink(M.tl, { category: "programare", title: "Ghid de programare în Java", description: "Ședință de ţinut", url: "https://a.ro" });
  resources.createLink(M.tl, { category: "regulamente", title: "Regulament", url: "https://b.ro" });
  const titles = (q, category) => resources.list(M.m, { q, category }).map((r) => r.title);
  assert.ok(titles("PROGRAMARE IN java").includes("Ghid de programare în Java"));
  assert.ok(titles("sedinta de tinut").includes("Ghid de programare în Java"));
  assert.ok(titles("şedinţă de").includes("Ghid de programare în Java")); // cedilla variants
  assert.ok(titles("ghid java").includes("Ghid de programare în Java")); // words need not be adjacent
  assert.deepEqual(titles("regulamente first"), ["Regulament"]); // category label is searchable
  assert.deepEqual(titles("zzzz"), []);
  assert.deepEqual(titles(undefined, "regulamente"), ["Regulament"]);
  const cats = resources.list(M.m, {}).map((r) => r.category);
  const idx = (c) => resources.listCategories().findIndex((x) => x.key === c);
  assert.deepEqual(cats, [...cats].sort((a, b) => idx(a) - idx(b)));
});

test("routes: list contract and can_manage flag", async () => {
  const m = await (await api("m", "GET", "/api/resources")).json();
  assert.equal(m.can_manage, false);
  assert.equal(m.categories.length, 8);
  assert.equal(m.categories[0].key, "regulamente");
  assert.ok(m.resources.length >= 2);
  for (const k of ["id", "category", "title", "description", "kind", "url", "file", "created_by_name", "created_at", "updated_at", "sort_order"]) assert.ok(k in m.resources[0], k);
  assert.equal((await (await api("me", "GET", "/api/resources")).json()).can_manage, true);
  assert.equal((await api("al", "GET", "/api/resources")).status, 200);
  assert.equal((await fetch(`${BASE}/api/resources`)).status, 401);
});

test("routes: create link (JSON), update, forbid member, delete", async () => {
  assert.equal((await api("m", "POST", "/api/resources", { kind: "link", category: "pr", title: "x", url: "https://x.ro" })).status, 403);
  const bad = await api("tl", "POST", "/api/resources", { kind: "link", category: "pr", title: "x", url: "javascript:1" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "INVALID");
  const res = await api("tl", "POST", "/api/resources", { kind: "link", category: "pr", title: "Canal", url: "https://x.ro" });
  assert.equal(res.status, 201);
  const { resource } = await res.json();
  const up = await (await api("ht", "PUT", `/api/resources/${resource.id}`, { title: "Canal nou", sort_order: -5 })).json();
  assert.equal(up.resource.title, "Canal nou");
  assert.equal(up.resource.sort_order, -5);
  assert.equal(up.resource.url, "https://x.ro");
  assert.equal((await api("m", "PUT", `/api/resources/${resource.id}`, { title: "h" })).status, 403);
  assert.equal((await api("m", "DELETE", `/api/resources/${resource.id}`)).status, 403);
  assert.deepEqual(await (await api("tl", "DELETE", `/api/resources/${resource.id}`)).json(), { ok: true });
  assert.equal((await api("tl", "DELETE", `/api/resources/${resource.id}`)).status, 404);
});

test("routes: multipart upload, Romanian filename headers, replace, delete", async () => {
  const res = await api("tl", "POST", "/api/resources", form({ category: "sponsorizari", title: "Contract", description: "șablon" }, { name: "Contract sponsorizare ăâîșț.pdf", content: "%PDF-1.4 x" }));
  assert.equal(res.status, 201);
  const { resource } = await res.json();
  assert.equal(resource.file.name, "Contract sponsorizare ăâîșț.pdf");
  assert.equal(resource.kind, "file");

  const dl = await api("m", "GET", `/api/resources/${resource.id}/file`);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), "%PDF-1.4 x");
  const cd = dl.headers.get("content-disposition");
  assert.match(cd, /^inline;/);
  assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent("Contract sponsorizare ăâîșț.pdf")}`), cd);
  assert.ok(dl.headers.get("content-type").startsWith("application/pdf"));
  assert.match((await api("m", "GET", `/api/resources/${resource.id}/file?download=1`)).headers.get("content-disposition"), /^attachment;/);

  const rep = await api("tl", "POST", `/api/resources/${resource.id}/file`, form({}, { name: "v2.docx", content: "doc" }));
  assert.equal(rep.status, 200);
  assert.equal((await rep.json()).resource.file.name, "v2.docx");
  const dl2 = await api("m", "GET", `/api/resources/${resource.id}/file`);
  assert.match(dl2.headers.get("content-disposition"), /^attachment;/); // not inline-safe
  await dl2.text();
  assert.equal((await api("m", "POST", `/api/resources/${resource.id}/file`, form({}, { name: "x.pdf", content: "x" }))).status, 403);

  const n = onDisk().length;
  await api("tl", "DELETE", `/api/resources/${resource.id}`);
  assert.equal(onDisk().length, n - 1);
  assert.equal((await api("m", "GET", `/api/resources/${resource.id}/file`)).status, 404);
});

test("routes: upload without file or with bad category is rejected", async () => {
  assert.equal((await api("tl", "POST", "/api/resources", form({ kind: "file", category: "pr", title: "x" }))).status, 400);
  assert.equal((await api("tl", "POST", "/api/resources", form({ category: "zzz" }, { name: "a.pdf", content: "x" }))).status, 400);
});

// ---- AI tool <-> route parity ----
async function tool(member) {
  const list = await buildToolList({ actor: member, channel: "web", chatId: `web:${member.id}` });
  return list.find((t) => t.name === "cauta_resurse");
}
const text = (r) => r.content[0].text;

test("cauta_resurse returns the same resources as GET /api/resources and absolute file links", async () => {
  const f = await (await api("tl", "POST", "/api/resources", form({ category: "sponsorizari", title: "Contract de sponsorizare" }, { name: "c.pdf", content: "x" }))).json();
  const t = await tool(M.m);
  assert.ok(t, "tool registered");
  const out = text(await t.handler({ query: "sponsorizare" }, {}));
  const route = await (await api("m", "GET", "/api/resources?q=sponsorizare")).json();
  for (const r of route.resources) assert.ok(out.includes(r.title), out);
  assert.ok(out.includes(`https://crocoai.perpetuummobile.tech/api/resources/${f.resource.id}/file`), out);
  const links = text(await t.handler({ category: "programare" }, {}));
  assert.ok(links.includes("https://a.ro") && links.includes("Programare"), links);
  assert.match(text(await t.handler({ query: "inexistentxyz" }, {})), /Nu am găsit/);
});

test("cauta_resurse refuses like the route for a non-member", async () => {
  const r = await (await tool({ ...M.m, status: "iesit" })).handler({}, {});
  assert.equal(r.isError, true);
  assert.ok(env);
});
