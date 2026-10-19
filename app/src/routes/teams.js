const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const groups = require("../services/groups");

const router = express.Router();
router.use(requireAuth);

// Legacy read shape, now through services/groups so visibility rules apply.
router.get("/", wrap((req, res) => {
  res.json(groups.list(req.user).map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    leaders: g.members.filter((m) => m.role === "leader").map(({ id, name, role }) => ({ id, name, role })),
    member_count: g.members.length,
  })));
}));

router.get("/:id", wrap((req, res) => {
  const g = groups.get(req.user, req.params.id);
  res.json({ id: g.id, name: g.name, description: g.description, members: g.members.map(({ id, name, role }) => ({ id, name, role })) });
}));

// Writes go through services/groups so the department rules apply here too (design-teme-grupuri.md §2).
router.post("/", wrap((req, res) => {
  const { name, description } = req.body || {};
  const g = groups.create(req.user, { name, description, department: "mixt" });
  res.json({ ok: true, id: g.id });
}));

router.put("/:id", wrap((req, res) => {
  const { name, description } = req.body || {};
  groups.update(req.user, req.params.id, { name: name || undefined, description });
  res.json({ ok: true });
}));

router.delete("/:id", wrap((req, res) => { groups.remove(req.user, req.params.id); res.json({ ok: true }); }));

router.post("/:id/members", wrap((req, res) => {
  const { member_id, role } = req.body || {};
  if (!member_id) return res.status(400).json({ error: "member_id obligatoriu" });
  groups.addMember(req.user, req.params.id, member_id, role);
  res.json({ ok: true });
}));

router.put("/:id/members/:memberId", wrap((req, res) => {
  groups.addMember(req.user, req.params.id, req.params.memberId, (req.body || {}).role);
  res.json({ ok: true });
}));

router.delete("/:id/members/:memberId", wrap((req, res) => {
  groups.removeMember(req.user, req.params.id, req.params.memberId);
  res.json({ ok: true });
}));

module.exports = router;
