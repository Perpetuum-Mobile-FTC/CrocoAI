// Minimal History API router. Routes are { pattern, load } where pattern uses :param segments.
// load(params, container) returns a cleanup function (optional) run before the next route mounts.

const routes = [];
let current = { cleanup: null };
let container = null;
let notFoundHandler = null;

export function register(pattern, load) {
  routes.push({ pattern, load, segments: pattern.split("/").filter(Boolean) });
}
export function setNotFound(handler) {
  notFoundHandler = handler;
}

function match(path) {
  const parts = path.split("/").filter(Boolean);
  for (const r of routes) {
    if (r.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

export async function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  await render();
}

export async function render() {
  const path = location.pathname;
  if (current.cleanup) { try { current.cleanup(); } catch (e) {} }
  const m = match(path);
  if (!m) {
    if (notFoundHandler) notFoundHandler(container);
    return;
  }
  const cleanup = await m.route.load(m.params, container, location.hash);
  current = { cleanup: typeof cleanup === "function" ? cleanup : null };
  document.dispatchEvent(new CustomEvent("route:changed", { detail: { path } }));
}

export function init(rootEl) {
  container = rootEl;
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-link]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("http") || a.target === "_blank") return;
    e.preventDefault();
    navigate(href);
  });
  window.addEventListener("popstate", render);
  render();
}
