// Redirect-back target after login (?next=..., design-sedinte-v3.md §2): only a same-origin path.
// Classic script (login.html has no modules) that is also require()-able by the node tests.
(function (root) {
  function safeNext(next, origin) {
    var n = typeof next === "string" ? next : "";
    if (!/^\/(?![\/\\])/.test(n)) return "/";
    var u;
    try { u = new URL(n, origin); } catch (e) { return "/"; }
    if (u.origin !== origin) return "/";
    // "/.//evil.com", "/%2e//evil.com", "/a/..//evil.com" resolve to the pathname "//evil.com", which the
    // browser would read as a protocol-relative URL: refuse anything that starts with "//" or "/\".
    if (/^\/[\/\\]/.test(u.pathname)) return "/";
    return u.pathname + u.search + u.hash;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { safeNext: safeNext };
  else root.safeNext = safeNext;
})(this);
