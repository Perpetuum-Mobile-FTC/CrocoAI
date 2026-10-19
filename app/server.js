const path = require("path");
const fs = require("fs");

// Minimal .env loader (no extra dependency): docker-compose uses env_file directly,
// this just helps when running `node server.js` locally.
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || "").trim();
  }
}

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const http = require("http");

const db = require("./src/db");
require("./src/db/seed").seed();

const { requireAuth } = require("./src/middleware/auth");
const { errorHandler, notFoundApi } = require("./src/middleware/error-handler");
const authRoutes = require("./src/routes/auth");
const memberRoutes = require("./src/routes/members");
const adminRoutes = require("./src/routes/admin");
const teamRoutes = require("./src/routes/teams");
const groupRoutes = require("./src/routes/groups");
const attendanceRoutes = require("./src/routes/attendance");
const absenceRoutes = require("./src/routes/absences");
const warningRoutes = require("./src/routes/warnings");
const taskRoutes = require("./src/routes/tasks");
const eventRoutes = require("./src/routes/events");
const reminderRoutes = require("./src/routes/reminders");
const notificationRoutes = require("./src/routes/notifications");
const aiRoutes = require("./src/routes/ai");
const messageRoutes = require("./src/routes/messages");
const documentRoutes = require("./src/routes/documents");
const regulamentRoutes = require("./src/routes/regulament");
const ftcDocsRoutes = require("./src/routes/ftc-docs");
const waGroupRoutes = require("./src/routes/wa-groups");
const photoRoutes = require("./src/routes/photos");
const meetingRoutes = require("./src/routes/meetings");
const onboardingRoutes = require("./src/routes/onboarding");
const applicationRoutes = require("./src/routes/applications");
const completionLinkRoutes = require("./src/routes/completion-links");
const publicRoutes = require("./src/routes/public");
const pages = require("./src/pages");
const announcementRoutes = require("./src/routes/announcements");
const deadlineRoutes = require("./src/routes/deadlines");
const homeRoutes = require("./src/routes/home");
const assignmentRoutes = require("./src/routes/assignments");
const resourceRoutes = require("./src/routes/resources");
const submissionRoutes = require("./src/routes/submissions");
const waIncomingRoutes = require("./src/routes/wa-incoming");
const reminderScheduler = require("./src/services/reminder-scheduler");
const pwa = require("./src/pwa");
const ftcManualUpdater = require("./src/services/ftc-manual-updater");

const app = express();
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"], // no 'unsafe-inline': every page loads its script from /js (A2)
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"], // Rajdhani is self-hosted in public/fonts (also needed offline)
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
    },
  },
}));
// 5 MB for everything; only the gateway-only /wa/media route (base64 photos/videos, up to 40 MB) parses its own body.
const jsonDefault = express.json({ limit: "5mb" });
app.use((req, res, next) => (req.path === "/wa/media" ? next() : jsonDefault(req, res, next)));
app.use(require("./src/middleware/scrub").scrubJson); // strips password_hash/token_version from every JSON response
app.use(cookieParser());

// WhatsApp gateway webhook (internal network only, not part of /api).
app.use(waIncomingRoutes);

app.use("/api/auth", authRoutes);
app.use("/api", memberRoutes); // /members, /members/:id, /guardians - no router-wide middleware, safe to share the prefix
app.use("/api/admin", adminRoutes);
app.use("/api/teams", teamRoutes); // legacy read/write shape over services/groups (deprecated, docs/api-v2.md)
app.use("/api/groups", groupRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/absences", absenceRoutes);
app.use("/api/warnings", warningRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/reminders", reminderRoutes); // compat view of tasks with remind_at (deprecated, docs/api-v2.md)
app.use("/api/notifications", notificationRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/regulament", regulamentRoutes);
app.use("/api/ftc-docs", ftcDocsRoutes);
app.use("/api/wa-groups", waGroupRoutes);
app.use("/api/photos", photoRoutes);
app.use("/api/meetings", meetingRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/completion-links", completionLinkRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/announcements", announcementRoutes);
app.use("/api/deadlines", deadlineRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/resources", resourceRoutes);
app.use("/api/submissions", submissionRoutes);
app.use("/api", messageRoutes); // /messages, /whatsapp/status, /health - no router-wide middleware, safe to share

app.use("/api", notFoundApi);

// Service worker (docs/design-pwa-ui.md §C): always revalidated, so a deploy reaches clients on the next load.
app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Service-Worker-Allowed", "/");
  res.send(pwa.serviceWorkerSource());
});
// The team's identity (src/domain/team.js) is filled into the manifest and the HTML pages (src/pages.js).
app.get("/manifest.json", (req, res) => {
  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  res.send(pages.render("manifest.json"));
});
app.get(pages.TEMPLATED, (req, res) => res.redirect(302, req.path === "/login.html" ? "/login" : req.path === "/inscriere.html" ? "/inscriere" : "/"));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// SPA routes - auth required, otherwise redirect to /login.
// Note: res.sendFile(absolutePath) 404s on Express 5.2 without an explicit `root` option
// (a behavior change vs 5.0) - read the file directly instead.
// Route list matches js/app.js's router registrations (incl. :id params for deep-linking/refresh on
// member profiles and the mobile attendance marking page). Sections + ?tab=: docs/design-meniu-v2.md §1.
const SPA_ROUTES = [
  "/", "/sedinte", "/sedinte/:id", "/teme", "/teme/:id", "/calendar", "/echipa", "/documente", "/chat", "/admin", "/anunturi",
  "/prezenta/sesiune/:id", "/membri/:id", "/cont",
  "/p/:token", // QR attendance scan (design-sedinte-v3.md §2)
];
// Old pages -> their section/tab (302, before the auth check: links already sent on WhatsApp keep working;
// the browser keeps a #fragment across the redirect, e.g. /regulament#art-5). Any incoming ?query is
// dropped on purpose: none of the old pages took query parameters that the new tabs understand.
const LEGACY_ROUTES = {
  "/prezenta": "/sedinte?tab=prezenta",
  "/taskuri": "/teme?tab=taskuri",
  "/remindere": "/teme?tab=taskuri",
  "/membri": "/echipa?tab=membri",
  "/grupuri": "/echipa?tab=grupuri",
  "/regulament": "/documente?tab=regulament",
  "/poze": "/documente?tab=poze",
  "/chat-echipa": "/anunturi", // the team chat was removed (pachet B); its Anunțuri channel lives on here
  "/mesaje": "/admin",
};
for (const [from, to] of Object.entries(LEGACY_ROUTES)) app.get(from, (req, res) => res.redirect(302, to));
for (const route of SPA_ROUTES) {
  app.get(route, (req, res) => {
    const token = req.cookies && req.cookies.crocoai_token;
    // Back to the same page (and tab) after login (e.g. a scanned QR link); login.html only follows same-origin paths.
    if (!token) return res.redirect(req.path === "/" ? "/login" : `/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(pages.render("index.html"));
  });
}
app.get("/login", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(pages.render("login.html"));
});

// Public pages (design-formular-date.md) - NO auth, NOT redirected to /login.
app.get("/inscriere", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(pages.render("inscriere.html"));
});
app.get("/completare/:token", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(pages.render("completare.html"));
});

// Unknown page (GET, browser): the SPA shell with status 404 - the router draws its „Pagina nu există” view
// (or sends the visitor to /login), instead of Express's bare „Cannot GET”.
app.use((req, res, next) => {
  // a missing file (/js/x.js, /icons/x.png...) stays a plain 404 - only page-like paths get the shell
  if (req.method !== "GET" || path.extname(req.path) || !req.accepts("html")) return next();
  res.status(404);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(pages.render("index.html"));
});

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[CrocoAI] Listening on port ${PORT}`);
    reminderScheduler.start();
    ftcManualUpdater.start();
    require("./src/services/wa-queue").start(); // sends what a restart left in the WhatsApp queue
  });
}

module.exports = { app, server };
