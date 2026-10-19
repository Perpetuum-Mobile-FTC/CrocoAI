// Offline fallback page (served by the service worker when a navigation fails). Reload as soon as the
// network is back, or on demand.
document.getElementById("retry-btn").addEventListener("click", () => location.reload());
window.addEventListener("online", () => location.reload());
