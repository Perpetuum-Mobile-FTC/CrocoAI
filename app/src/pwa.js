// Builds the service worker served at /sw.js from public/sw.js (docs/design-pwa-ui.md §C):
// __PRECACHE__ = the app shell (CSS, JS, icons, local fonts, offline page, manifest),
// __VERSION__  = a hash of those files, so each deploy that changes the shell gets a new cache (no manual bump).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUBLIC = path.join(__dirname, "..", "public");
const SHELL_DIRS = ["css", "js", "icons", "fonts"];
const SHELL_FILES = ["/offline.html", "/manifest.json"];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

function precacheList() {
  const files = SHELL_DIRS.flatMap((d) => walk(path.join(PUBLIC, d)))
    .map((f) => "/" + path.relative(PUBLIC, f).split(path.sep).join("/"))
    .filter((u) => !path.basename(u).startsWith(".") && !u.endsWith(".txt")); // e.g. fonts/OFL.txt
  return [...files.sort(), ...SHELL_FILES];
}

let cached = null;
function serviceWorkerSource() {
  if (cached) return cached;
  const list = precacheList();
  const hash = crypto.createHash("sha256");
  for (const u of [...list, "/sw.js"]) hash.update(u).update(fs.readFileSync(path.join(PUBLIC, u)));
  hash.update(JSON.stringify(require("./domain/team").TEAM)); // the manifest is filled from it
  const version = hash.digest("hex").slice(0, 12);
  cached = fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8")
    .replace(`const VERSION = "__VERSION__";`, `const VERSION = "${version}";`)
    .replace("const PRECACHE = __PRECACHE__;", `const PRECACHE = ${JSON.stringify(list)};`);
  return cached;
}

module.exports = { serviceWorkerSource, precacheList };
