const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("assign_routes");
const { server } = require("../server");
const db = require("../src/db");

let M, BASE, C;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "a", role: "member", department: "tehnic" },
    { key: "b", role: "member", department: "tehnic" },
  ]);
  C = { ht: await login(BASE, M.ht.phone), a: await login(BASE, M.a.phone), b: await login(BASE, M.b.phone) };
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

const json = (cookie, method, url, body) => fetch(`${BASE}${url}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });

async function createWithMaterial() {
  const fd = new FormData();
  fd.append("title", "CAD");
  fd.append("mode", "individual");
  fd.append("target_type", "departament");
  fd.append("target_dept", "tehnic");
  fd.append("todos", JSON.stringify(["Schiță"]));
  fd.append("materials", new Blob(["pdf-bytes"], { type: "application/pdf" }), "Temă CAD.pdf");
  const res = await fetch(`${BASE}/api/assignments`, { method: "POST", headers: { Cookie: C.ht }, body: fd });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

test("create multipart -> material name keeps diacritics, member downloads it as attachment", async () => {
  const a = await createWithMaterial();
  assert.equal(a.materials[0].filename, "Temă CAD.pdf");
  const res = await fetch(`${BASE}/api/assignments/${a.id}/materials/${a.materials[0].id}`, { headers: { Cookie: C.a } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename\*=UTF-8''Tem%C4%83%20CAD\.pdf/);
  assert.equal(await res.text(), "pdf-bytes");
});

test("upload over 25 MB -> 400 with the exact message", async () => {
  const a = await createWithMaterial();
  const sub = a.submissions.find((s) => s.member_id === M.a.id);
  const fd = new FormData();
  fd.append("files", new Blob([Buffer.alloc(25 * 1024 * 1024 + 1)]), "big.bin");
  const res = await fetch(`${BASE}/api/submissions/${sub.id}/files`, { method: "POST", headers: { Cookie: C.a }, body: fd });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Fișier prea mare (max 25 MB).");
});

test("full cycle over HTTP + another member gets 403 on the file", async () => {
  const a = await createWithMaterial();
  const sub = a.submissions.find((s) => s.member_id === M.a.id);
  const fd = new FormData();
  fd.append("files", new Blob(["v1"]), "lucrare.txt");
  const up = await fetch(`${BASE}/api/submissions/${sub.id}/files`, { method: "POST", headers: { Cookie: C.a }, body: fd });
  assert.equal(up.status, 200);
  const fileId = (await up.json()).files[0].id;
  assert.equal((await json(C.a, "POST", `/api/submissions/${sub.id}/submit`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/submissions/${sub.id}/files/${fileId}`, { headers: { Cookie: C.b } })).status, 403);
  assert.equal((await fetch(`${BASE}/api/submissions/${sub.id}/files/${fileId}`, { headers: { Cookie: C.ht } })).status, 200);
  const rev = await json(C.ht, "POST", `/api/submissions/${sub.id}/review`, { decision: "acceptat" });
  assert.equal((await rev.json()).status, "acceptat");
});

test("targets, list scopes, to-do toggle, close, delete-with-submissions refused", async () => {
  const t = await (await json(C.ht, "GET", "/api/assignments/targets")).json();
  assert.deepEqual(t.departments, ["tehnic"]);
  assert.deepEqual(await (await json(C.a, "GET", "/api/assignments/targets")).json(), { departments: [], groups: [] });
  const created = await (await json(C.ht, "POST", "/api/assignments", { title: "JSON", mode: "individual", target_type: "departament", target_dept: "tehnic", todos: ["a"] })).json();
  const mine = await (await json(C.a, "GET", "/api/assignments?scope=mine&status=activa")).json();
  assert.ok(mine.some((x) => x.id === created.id));
  const sub = created.submissions.find((s) => s.member_id === M.a.id);
  const tog = await json(C.a, "PATCH", `/api/submissions/${sub.id}/todos/${created.todos[0].id}`, { done: true });
  assert.equal((await tog.json()).todos[0].done, true);
  assert.equal((await json(C.a, "POST", `/api/submissions/${sub.id}/submit`)).status, 200);
  assert.equal((await json(C.ht, "DELETE", `/api/assignments/${created.id}`)).status, 400);
  assert.equal((await (await json(C.ht, "POST", `/api/assignments/${created.id}/close`)).json()).status, "inchisa");
  assert.equal((await json(C.a, "GET", "/api/assignments?scope=all")).status, 403);
});
