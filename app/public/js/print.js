// Print button of the server-rendered printable pages (attendance export, document templates). A static file
// because the CSP allows no inline script or onclick (security package A2).
document.querySelectorAll("[data-print]").forEach((btn) => btn.addEventListener("click", () => window.print()));
