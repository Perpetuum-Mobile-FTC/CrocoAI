// Menu model (docs/design-meniu-v2.md §1): sections, their tabs and who sees them. Pure - no imports, no
// DOM - so the node tests can check it per role. No role lists: `user` is GET /api/auth/me, whose
// `permissions` (policy.UI_ACTIONS) and `meetings_section` come from policy.js; the server re-checks everything.
const all = () => true;
const may = (action) => (u) => !!(u.permissions && u.permissions[action]);
const leaders = may("members.manage"); // Admin, Cereri de rol
const managers = may("deadlines.manage"); // Admin → Termene
const meetings = (u) => !!u.meetings_section;

// `also`: other path prefixes that belong to the section (deep links kept from before).
export const SECTIONS = [
  { key: "acasa", label: "Acasă", path: "/", icon: "acasa", show: all },
  { key: "sedinte", label: "Ședințe", path: "/sedinte", icon: "sedinte", show: meetings, also: ["/prezenta/"],
    tabs: [{ key: "sedinte", label: "Ședințe", show: meetings }, { key: "prezenta", label: "Prezență", show: all }] },
  { key: "teme", label: "Teme", path: "/teme", icon: "teme", show: all,
    tabs: [{ key: "teme", label: "Teme", show: all }, { key: "taskuri", label: "Taskuri", show: all }] },
  { key: "calendar", label: "Calendar", path: "/calendar", icon: "calendar", show: all },
  { key: "echipa", label: "Echipă", path: "/echipa", icon: "membri", show: all, also: ["/membri/"],
    tabs: [{ key: "membri", label: "Membri", show: all }, { key: "grupuri", label: "Grupuri", show: all }, { key: "cereri", label: "Cereri", show: leaders }] },
  { key: "documente", label: "Documente", path: "/documente", icon: "documente", show: all,
    tabs: [{ key: "documente", label: "Documente", show: all }, { key: "resurse", label: "Resurse", show: all }, { key: "regulament", label: "Regulament", show: all }, { key: "poze", label: "Poze", show: all }] },
  { key: "chat", label: "Chat AI", path: "/chat", icon: "chat", show: all },
  { key: "admin", label: "Admin", path: "/admin", icon: "admin", show: managers,
    tabs: [{ key: "admin", label: "Admin", show: leaders }, { key: "cereri-rol", label: "Cereri de rol", show: leaders }, { key: "termene", label: "Termene", show: managers }] },
];

export function visibleSections(user) {
  return SECTIONS.filter((s) => s.show(user));
}

export function visibleTabs(section, user) {
  return (section.tabs || []).filter((t) => t.show(user));
}

// The requested ?tab= if the user may see it, otherwise the first visible tab (null if none).
export function activeTab(section, user, requested) {
  const tabs = visibleTabs(section, user);
  const hit = tabs.find((t) => t.key === requested);
  return hit ? hit.key : (tabs[0] ? tabs[0].key : null);
}

// Phone bottom bar (4 items + „Mai mult”): leadership (those who see Ședințe) vs. members.
export function bottomKeys(user) {
  return meetings(user) ? ["acasa", "sedinte", "teme", "chat"] : ["acasa", "teme", "calendar", "chat"];
}

// Which section a path belongs to (nav highlighting).
export function sectionForPath(path) {
  if (path === "/" || path === "/anunturi") return "acasa";
  const s = SECTIONS.find((x) => x.path !== "/" && (path === x.path || path.startsWith(x.path + "/") || (x.also || []).some((p) => path.startsWith(p))));
  return s ? s.key : null;
}
