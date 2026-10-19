const { DomainError, statusFor } = require("../domain/errors");

// Wraps an async route handler so thrown/rejected errors reach the error handler below
// instead of crashing the process (Express 5 does this automatically for async handlers that
// return a rejected promise, but we keep this explicit for clarity and for sync throws).
function wrap(fn) {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

// Global JSON error handler - no HTML error page ever (audit fix).
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof DomainError) {
    return res.status(statusFor(err.code)).json({ error: err.message, article: err.article || undefined, code: err.code, errors: err.fieldErrors || undefined, ...(err.extra || {}) });
  }
  // body-parser errors are client errors, not server faults
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Cererea este prea mare." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Date invalide (JSON)." });
  console.error("[ERROR]", err.stack || err.message);
  res.status(500).json({ error: "Eroare internă de server" });
}

// 404 JSON handler for unmatched /api routes.
function notFoundApi(req, res) {
  res.status(404).json({ error: "Rută inexistentă" });
}

module.exports = { wrap, errorHandler, notFoundApi };
