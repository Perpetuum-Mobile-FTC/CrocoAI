# CrocoAI — Pachete C (PWA) + D (interfață), din auditul 2026-10-16 (aprobat de Luca)

## C. PWA
- Service worker `/sw.js` (servit cu `Cache-Control: no-cache`, scope `/`): precache shell (CSS, JS, iconițe, fonturi
  locale, pagina `/offline.html`); network-first pentru navigări cu fallback la `/offline.html`; cache-first pentru
  assets versionate; **niciodată** `/api/*` (date autentificate nu se cache-uiesc). Versiune de cache bump la deploy.
- Înregistrare SW din toate paginile (index, login, inscriere, completare) — script extern (CSP fără inline).
- Manifest: `id`, `scope:"/"`, `lang:"ro"`, `start_url:"/?source=pwa"`, orientare liberă, iconițe separate `any` și
  `maskable` (cu ~10% margine de siguranță), apple-touch-icon 180px.
- Toate cele 4 pagini HTML: manifest, `theme-color`, favicon, `apple-mobile-web-app-capable`,
  `apple-mobile-web-app-title`, `apple-mobile-web-app-status-bar-style`, `viewport-fit=cover`.
- Safe-area sus (topbar) și lateral (landscape).
- Buton discret „Instalează aplicația” (beforeinstallprompt) pe Acasă; pe iOS instrucțiune „Share → Adaugă pe ecran”.
- Fontul Rajdhani servit local (nu `@import` Google) — necesar și pentru offline.

## D. Interfață (din auditul UX)
- Contrast: text închis pe butonul primar (sau gradient mai închis) ≥ 4.5:1; `.card-header a:not(.btn)`; reset global
  `a{color:inherit;text-decoration:none}`, `a.btn` fără subliniere; `--text-dim` mai deschis (≥ 4.5:1).
- Login: `min-height:100dvh`, scroll permis (landscape/tastatură), `<form>` real, buton „arată parola”.
- Input-uri 16px pe mobil (fără zoom iOS); butoane/țintele de atingere ≥ 44px (checkbox task, ✎/×, P/A/M, chip-uri,
  clopoțel, „Album nou”).
- Spațiere: grilă de 3 pentru statistici pe mobil, fără dubluri; titlurile secțiunilor de pe pagina ședinței cu spațiu
  deasupra; înscrierea fără goluri de 30px; carduri mai compacte pe mobil; butonul „Acasă” de pe pagina de scanare.
- Accesibilitate: `<label>`/`aria-label` pe câmpurile doar cu placeholder; `openModal` cu `role="dialog"`,
  `aria-labelledby`, focus inițial, focus-trap, Escape corect (fără leak); „Mai mult” cu role + închidere la Escape;
  P/A/M cu `aria-label`; numărul de notificări în `aria-label`-ul clopoțelului; focus ring vizibil.
- Erori: înscrierea face scroll + focus pe primul câmp invalid; 403 fără „Reîncearcă” (cu „Înapoi”); pagina 404 a SPA
  pentru adrese necunoscute (nu „Cannot GET”).
- Copy și consistență: „Eroare de rețea”, date dd.mm.yyyy peste tot, „Creează tema”, butoane „+ …” consistente,
  iconiță de logout corectă, eticheta „Chat AI”; buton de fișier stilizat în română („Alege fișier”).
- QR: fără polling cât codul nu e disponibil (mesaj + reîncercare la deschidere), URL-ul cu token ascuns.
- Chat: fără overflow; Shift+Enter = rând nou pe desktop, Enter = rând nou pe mobil (buton Trimite).
- Hover fără deplasarea layout-ului; reminder în trecut → avertisment.

## Teste
Teste automate unde se poate (manifest valid, SW servit cu header corect și fără /api în cache, 404 SPA); verificare în
browser la 390/320/1280 + landscape pe toate paginile cu roluri diferite, Lighthouse PWA/accesibilitate dacă e posibil,
offline (reload → pagina offline), zero erori de consolă/CSP.
