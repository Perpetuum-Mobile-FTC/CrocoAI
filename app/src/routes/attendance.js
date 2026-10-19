const { TEAM } = require("../domain/team");
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const attendance = require("../services/attendance");

const router = express.Router();
router.use(requireAuth);

router.get("/sessions", wrap((req, res) => {
  res.json(attendance.listSessions(req.user, req.query));
}));

router.post("/sessions", wrap((req, res) => {
  res.json(attendance.createSession(req.user, req.body));
}));

router.get("/sessions/:id", wrap((req, res) => {
  res.json(attendance.getSessionDetail(req.user, req.params.id));
}));

router.put("/sessions/:id", wrap((req, res) => {
  res.json(attendance.updateSession(req.user, req.params.id, req.body));
}));

router.delete("/sessions/:id", wrap((req, res) => {
  attendance.deleteSession(req.user, req.params.id);
  res.json({ ok: true });
}));

router.put("/sessions/:id/records", wrap((req, res) => {
  const { records } = req.body || {};
  res.json(attendance.markRecords(req.user, req.params.id, records));
}));

router.get("/stats", wrap((req, res) => {
  const { member_id, from, to, team_id } = req.query;
  if (member_id) return res.json(attendance.statsFor(req.user, member_id, { from, to }));
  res.json(attendance.statsAll(req.user, { from, to, team_id }));
}));

router.get("/grid", wrap((req, res) => {
  res.json(attendance.buildGrid(req.user, req.query));
}));

router.get("/export/csv", wrap((req, res) => {
  const { sessions, members } = attendance.buildGrid(req.user, req.query);
  const header = ["Membru", ...sessions.map((s) => `${s.date} ${s.start_time || ""} (${s.type})`.trim()), "Total"];
  const rows = [header];
  const SYMBOL = { prezent: "P", absent: "A", motivat: "M", scutit: "S" };
  for (const m of members) {
    const cells = sessions.map((s) => SYMBOL[m.records[s.id]] || "-");
    rows.push([m.name, ...cells, cells.filter((c) => c === "P").length]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=prezenta.csv");
  res.send("﻿" + csv);
}));

router.get("/export/html", wrap((req, res) => {
  const { sessions, members } = attendance.buildGrid(req.user, req.query);
  const SYMBOL = { prezent: "P", absent: "A", motivat: "M", scutit: "S" };
  const rows = members.map((m) => {
    const cells = sessions.map((s) => `<td style="text-align:center">${SYMBOL[m.records[s.id]] || "-"}</td>`).join("");
    return `<tr><td>${esc(m.name)}</td>${cells}</tr>`;
  }).join("");
  const headCells = sessions.map((s) => `<th>${esc(s.date)}<br>${esc(s.start_time || "")}</th>`).join("");
  const html = `<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8"><title>Prezență - ${esc(TEAM.name)}</title>
  <style>@media print{body{margin:0}} body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 10px;font-size:0.85em}th{background:#eee}</style>
  </head><body><h2>Prezență - ${esc(TEAM.name)}</h2><button type="button" data-print>Printează</button>
  <table><thead><tr><th>Membru</th>${headCells}</tr></thead><tbody>${rows}</tbody></table>
  <script src="/js/print.js"></script></body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}));

function esc(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

module.exports = router;
