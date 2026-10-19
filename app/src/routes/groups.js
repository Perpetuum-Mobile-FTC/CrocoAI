const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const groups = require("../services/groups");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => res.json(groups.list(req.user))));
router.get("/departments", wrap((req, res) => res.json({ departments: groups.creatableDepartments(req.user) })));
router.post("/", wrap((req, res) => res.json(groups.create(req.user, req.body || {}))));
router.get("/:id", wrap((req, res) => res.json(groups.get(req.user, req.params.id))));
router.patch("/:id", wrap((req, res) => res.json(groups.update(req.user, req.params.id, req.body || {}))));
router.delete("/:id", wrap((req, res) => { groups.remove(req.user, req.params.id); res.json({ ok: true }); }));
router.put("/:id/members", wrap((req, res) => res.json(groups.setMembers(req.user, req.params.id, (req.body || {}).members))));

module.exports = router;
