// Pachete C (PWA) + D (interfață), docs/design-pwa-ui.md: manifest, service worker, SPA 404, page heads, CSP/fonts,
// plus the pure UI helpers. The browser checks (install, offline reload, layouts) are done with playwright.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

const DB_FILE = path.join(__dirname, "._pwa_ui_test.db");
process.env.DB_PATH = DB_FILE;
process.env.JWT_SECRET = "test-jwt-secret";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const { server } = require("../server");
const PUBLIC = path.join(__dirname, "..", "public");
let BASE;

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
});

test("manifest: id, scope, lang, start_url, free orientation, separate any + maskable icons that exist", async () => {
  const res = await fetch(`${BASE}/manifest.json`);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.id, "/");
  assert.equal(m.scope, "/");
  assert.equal(m.lang, "ro");
  assert.equal(m.start_url, "/?source=pwa");
  assert.equal(m.display, "standalone");
  assert.equal(m.orientation, undefined, "no orientation lock (landscape allowed)");
  assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
  for (const icon of m.icons) {
    assert.ok(["any", "maskable"].includes(icon.purpose), `one purpose per icon, got "${icon.purpose}"`);
    assert.ok(fs.existsSync(path.join(PUBLIC, icon.src)), `${icon.src} exists`);
  }
  for (const purpose of ["any", "maskable"]) {
    for (const size of ["192x192", "512x512"]) {
      assert.ok(m.icons.some((i) => i.purpose === purpose && i.sizes === size), `${purpose} ${size}`);
    }
  }
});

test("maskable icons are opaque with a safe margin; apple-touch-icon is 180px", async () => {
  const sharp = require("sharp");
  for (const [file, size] of [["icon-maskable-512.png", 512], ["icon-maskable-192.png", 192], ["apple-touch-icon.png", 180]]) {
    const img = sharp(path.join(PUBLIC, "icons", file));
    const meta = await img.metadata();
    assert.equal(meta.width, size);
    assert.equal(meta.height, size);
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => data.slice((y * info.width + x) * 4, (y * info.width + x) * 4 + 4);
    assert.equal(px(0, 0)[3], 255, `${file}: opaque corner`);
    if (file.startsWith("icon-maskable")) {
      // ~10% margin: the outer 10% band is plain background (no green from the glyph)
      const band = Math.floor(size * 0.1) - 1;
      for (const [x, y] of [[band, size / 2], [size / 2, band], [size - band, size / 2], [size / 2, size - band]]) {
        const [r, g, b] = px(Math.floor(x), Math.floor(y));
        assert.ok(r < 30 && g < 30 && b < 30, `${file}: margin pixel (${x},${y}) is dark`);
      }
    }
  }
});

test("/sw.js: JavaScript, Cache-Control no-cache, filled-in version and shell list without /api", async () => {
  const res = await fetch(`${BASE}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/javascript/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const src = await res.text();
  assert.doesNotMatch(src, /__VERSION__|__PRECACHE__/);
  assert.match(src, /const VERSION = "[0-9a-f]{12}";/);
  const list = JSON.parse(src.match(/const PRECACHE = (\[.*\]);/)[1]);
  for (const must of ["/offline.html", "/css/style.css", "/js/app.js", "/js/pwa.js", "/fonts/rajdhani-600-latin.woff2", "/icons/icon-192.png", "/manifest.json"]) {
    assert.ok(list.includes(must), `precache has ${must}`);
  }
  assert.ok(list.every((u) => !u.startsWith("/api")), "nothing under /api is precached");
  assert.ok(list.every((u) => fs.existsSync(path.join(PUBLIC, u))), "every precached file exists");
});

// Runs the real service worker source in a sandbox with fake caches/fetch and checks what it does per request.
async function loadServiceWorker() {
  const src = await (await fetch(`${BASE}/sw.js`)).text();
  const handlers = {};
  const cache = new Map();
  const cachePuts = [];
  const sandbox = {
    URL, Request: class { constructor(url) { this.url = url; } },
    Response: { error: () => "Response.error()" },
    self: { location: { origin: "https://croco.test" }, addEventListener: (t, fn) => { handlers[t] = fn; },
      skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() } },
    caches: {
      open: async () => ({
        addAll: async (reqs) => { for (const r of reqs) { cache.set(r.url, `cached:${r.url}`); cachePuts.push(r.url); } },
        put: async (k) => { cachePuts.push(String(k.url || k)); },
      }),
      match: async (k) => cache.get(typeof k === "string" ? k : k.url) || undefined,
      keys: async () => [], delete: async () => true,
    },
    fetch: async () => { throw new Error("offline"); },
  };
  sandbox.self.caches = sandbox.caches;
  vm.runInNewContext(src, sandbox);
  let installDone;
  handlers.install({ waitUntil: (p) => { installDone = p; } });
  await installDone;
  function dispatch(url, { method = "GET", mode = "cors" } = {}) {
    let responded = null;
    handlers.fetch({ request: { url, method, mode }, respondWith: (p) => { responded = p; } });
    return responded;
  }
  return { dispatch, cachePuts, sandbox };
}

test("service worker: /api is never intercepted or cached; offline navigation -> /offline.html; shell cache-first", async () => {
  const sw = await loadServiceWorker();
  assert.ok(sw.cachePuts.every((u) => !u.startsWith("/api")));
  assert.equal(sw.dispatch("https://croco.test/api/home"), null, "/api GET passes straight through");
  assert.equal(sw.dispatch("https://croco.test/api/auth/me", { mode: "navigate" }), null, "/api even as a navigation");
  assert.equal(sw.dispatch("https://croco.test/api/tasks", { method: "POST" }), null);
  assert.equal(sw.dispatch("https://other.test/x.js"), null, "cross-origin untouched");
  assert.equal(sw.dispatch("https://croco.test/api/photos/1/medium"), null);
  assert.equal(await sw.dispatch("https://croco.test/teme", { mode: "navigate" }), "cached:/offline.html");
  assert.equal(await sw.dispatch("https://croco.test/css/style.css"), "cached:/css/style.css");
  assert.equal(sw.dispatch("https://croco.test/uploads/x.png"), null, "non-shell files go to the network");
  // offline page missing from the cache (evicted): a network error, never `undefined` passed to respondWith
  const realMatch = sw.sandbox.caches.match;
  sw.sandbox.caches.match = async () => undefined;
  assert.equal(await sw.dispatch("https://croco.test/sedinte", { mode: "navigate" }), "Response.error()");
  sw.sandbox.caches.match = realMatch;
  // the source itself never stores a response at runtime (only the install-time shell)
  const src = await (await fetch(`${BASE}/sw.js`)).text();
  assert.doesNotMatch(src, /cache\.put\(|\.put\(/);
  assert.match(src, /startsWith\("\/api\/"\)\) return/);
});

test("unknown page -> SPA shell with status 404 (router shows „Pagina nu există”), not Express's „Cannot GET”", async () => {
  const res = await fetch(`${BASE}/nu-exista/deloc`, { headers: { Accept: "text/html" }, redirect: "manual" });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.doesNotMatch(html, /Cannot GET/);
  assert.match(html, /id="app-shell"/);
  const app = fs.readFileSync(path.join(PUBLIC, "js", "app.js"), "utf8");
  assert.match(app, /setNotFound\([\s\S]*Pagina nu există/);
  // a missing file keeps a plain 404, not the HTML shell
  const missing = await fetch(`${BASE}/js/nu-exista.js`, { headers: { Accept: "text/html" } });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /id="app-shell"/);
  // /api keeps its JSON answers (401 here: not logged in) - never the HTML shell
  const api = await fetch(`${BASE}/api/nu-exista`, { headers: { Accept: "text/html" } });
  assert.notEqual(api.status, 200);
  assert.match(api.headers.get("content-type"), /application\/json/);
});

test("every HTML page: manifest, theme-color, favicon, apple tags, viewport-fit=cover, pwa.js, no inline scripts", () => {
  for (const file of ["index.html", "login.html", "inscriere.html", "completare.html"]) {
    const html = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    for (const re of [/<link rel="manifest" href="\/manifest.json">/, /<meta name="theme-color"/, /<link rel="icon" href="\/icons\/favicon.svg"/,
      /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon.png">/, /apple-mobile-web-app-capable/, /apple-mobile-web-app-title/,
      /apple-mobile-web-app-status-bar-style/, /viewport-fit=cover/, /<script src="\/js\/pwa.js"/]) {
      assert.match(html, re, `${file}: ${re}`);
    }
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${file}: no inline <script>`);
    assert.doesNotMatch(html, /\son[a-z]+=/i, `${file}: no inline event handlers`);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  }
  const login = fs.readFileSync(path.join(PUBLIC, "login.html"), "utf8");
  assert.match(login, /<form[^>]*id="login-form"[^>]*method="post"/);
  assert.match(login, /<form[^>]*id="change-pw-form"[^>]*method="post"/);
  assert.match(login, /data-pw-toggle="password"/);
  assert.doesNotMatch(login, /overflow:\s*hidden/);
  assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, "inscriere.html"), "utf8"), /<form[^>]*autocomplete="off"/);
});

test("Rajdhani is self-hosted: CSP font-src 'self' only, no Google @import, every @font-face file exists", async () => {
  const res = await fetch(`${BASE}/login`);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /font-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /googleapis|gstatic/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /unsafe-inline/);
  assert.match(csp, /worker-src 'self'/);
  const css = fs.readFileSync(path.join(PUBLIC, "css", "style.css"), "utf8");
  assert.doesNotMatch(css, /@import|googleapis/);
  const fonts = [...css.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(fonts.length, 8, "4 weights x latin + latin-ext");
  for (const f of fonts) assert.ok(fs.existsSync(path.join(PUBLIC, f)), f);
  assert.match(fs.readFileSync(path.join(PUBLIC, "fonts", "OFL.txt"), "utf8"), /SIL Open Font License/);
});

test("contrast tokens: primary buttons use dark text on a light-enough gradient, --text-dim >= 4.5:1", () => {
  const css = fs.readFileSync(path.join(PUBLIC, "css", "style.css"), "utf8");
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const grad = css.match(/--btn-gradient: linear-gradient\(90deg, (#[0-9a-f]{6}), var\(--primary\)\)/i)[1];
  const onPrimary = css.match(/--on-primary: (#[0-9a-f]{6})/i)[1];
  const primary = css.match(/--primary: (#[0-9a-f]{6})/i)[1];
  assert.ok(ratio(onPrimary, grad) >= 4.5, `gradient start ${ratio(onPrimary, grad).toFixed(2)}`);
  assert.ok(ratio(onPrimary, primary) >= 4.5);
  const dim = css.match(/--text-dim: (#[0-9a-f]{6})/i)[1];
  assert.ok(ratio(dim, "#0a0a0a") >= 4.5, `--text-dim ${ratio(dim, "#0a0a0a").toFixed(2)}`);
  assert.match(css, /\.card-header a:not\(\.btn\)/);
  assert.match(css, /^a \{ color: inherit; text-decoration: none; \}/m);
  assert.doesNotMatch(css, /:hover \{ padding-left/);
  assert.doesNotMatch(css, /translateY\(-1px\)/);
});

test("ui helpers: 403 offers „Înapoi” (no retry), styled Romanian file picker, dialog semantics in the source", async () => {
  const tmp = path.join(__dirname, "._pwa_ui_ui.mjs"); // .mjs copy: public/js is ESM without a package "type"
  fs.copyFileSync(path.join(PUBLIC, "js", "ui.js"), tmp);
  let ui;
  try { ui = await import(pathToFileURL(tmp).href); } finally { fs.unlinkSync(tmp); }
  const forbidden = ui.errorHtml(Object.assign(new Error("Nu ai acces."), { status: 403 }));
  assert.match(forbidden, /data-back/);
  assert.doesNotMatch(forbidden, /data-retry/);
  assert.match(ui.errorHtml(Object.assign(new Error("x"), { status: 500 })), /data-retry/);
  const picker = ui.fileField("f1", { accept: ".pdf" });
  assert.match(picker, /Alege fișier/);
  assert.match(picker, /<input type="file" id="f1"/);
  assert.doesNotMatch(ui.fileField('"><img src=x onerror=alert(1)>'), /<img/);
  const src = fs.readFileSync(path.join(PUBLIC, "js", "ui.js"), "utf8");
  assert.match(src, /role="dialog" aria-modal="true"/);
  assert.match(src, /aria-labelledby/);
  assert.match(src, /removeEventListener\("keydown", onKey, true\)/);
  // stacked dialogs: only the top one reacts, Escape does not reach the one underneath
  assert.match(src, /dialogStack\[dialogStack\.length - 1\] !== entry\) return/);
  assert.match(src, /stopImmediatePropagation\(\)/);
  assert.match(fs.readFileSync(path.join(PUBLIC, "js", "pages", "poze.js"), "utf8"), /trapDialog\(overlay, overlay/);
  // QR: 4xx stops polling, network / 5xx keeps it with „Se reîncearcă…”
  const sed = fs.readFileSync(path.join(PUBLIC, "js", "pages", "sedinte.js"), "utf8");
  assert.match(sed, /const domainAnswer = e\.status >= 400 && e\.status < 500;/);
  assert.match(sed, /Se reîncearcă…/);
  const app = fs.readFileSync(path.join(PUBLIC, "js", "app.js"), "utf8");
  assert.match(app, /setAttribute\("aria-label", n === 0 \? "Notificări"/);
  assert.match(app, /sheet\.setAttribute\("role", "dialog"\)/);
  assert.match(app, /svg\("logout"\)/);
});
