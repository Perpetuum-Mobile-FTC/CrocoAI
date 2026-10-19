# CrocoAI Faza 2 — Poze cu consimțământ (C2)

Owner: `src/services/photos.js`, `src/services/wa-media.js`, `src/routes/photos.js`,
`src/ai/tools-photos.js`, `public/js/pages/poze.js`. Design: `docs/design-phase2.md` §5, §7
(contract gateway). Reguli: `src/domain/rules.js` `photoPublication()` (Art. 59.1/59.2, 45.4).
Permisiuni: `src/domain/policy.js` `photos.*` (Art. §2 din design-phase2.md).

Toate endpoint-urile de mai jos (cu excepția `/wa/media`) necesită cookie-ul `crocoai_token`
(`requireAuth`), la fel ca restul API-ului v2. Erorile sunt `DomainError` → `{error, article?, code}`
(design-v2 §1).

---

## Model de date (`006_photos.sql`)

- `albums(id, title, month, event_id, session_id, source, wa_group_id, created_by, created_at)` —
  un album poate fi legat de un eveniment/sesiune, sau poate fi doar o lună. Albumele `source:
  'whatsapp'` au `wa_group_id` + `month` unice (un album per grup urmărit per lună).
- `photos(id, album_id, file_path, thumb_path, mime, media_type, size, original_name, uploaded_by,
  source, wa_msg_id, published, published_by, published_at, reported_private, reported_by,
  reported_at, uploaded_at)`. `published` e doar decizia explicită LEADERS (Art. 59.5) — **nu**
  reflectă dacă poza poate fi publicată chiar acum (asta se recalculează mereu live, niciodată
  stocat ca boolean învechit).
- `photo_tags(photo_id, member_id, tagged_by, tagged_at)`.
- `photo_consent_withdrawals(id, member_id, withdrawn_at)` — jurnal de audit, niciodată șters;
  o retragere "câștigă" doar dacă e mai recentă decât ultima aprobare a Anexei 13 a membrului
  (re-semnarea anulează o retragere mai veche).

Fișierele: `app/data/photos/<yyyy>/<mm>/<uuid>.<ext>` (+ `<uuid>.thumb.jpg` pentru imagini, generat
cu `sharp`; HEIC și video rămân fără thumbnail dacă generarea eșuează — comportament acceptat,
design §5). Servite DOAR prin rutele autorizate de mai jos, niciodată static.

## Starea de publicare (calculată live, niciodată stocată)

`photosSvc.publicationFor(photoId)` adună toate etichetele pozei, ia consimțământul curent al
fiecărui membru etichetat (`anexa13_foto_video` aprobat și neretras) și apelează
`rules.photoPublication()`. Rezultatul (`{ publishable, article, message, missing? }`) e recalculat
la fiecare citire — o retragere de acord sau o nouă aprobare schimbă instant starea tuturor pozelor
existente, fără nicio migrare de date.

---

## Albume — `/api/photos/albums`

### GET /albums
`photos.view` (activi/pauza/alumni). `[{ id, title, month, event_id, session_id, source,
wa_group_id, created_by, created_at, photo_count }]`.

### POST /albums
`photos.upload` (status `activ`). Body: `{ title, month?, event_id?, session_id? }`.

### GET /albums/:id/photos
`photos.view`. Fiecare poză include `tags: [{member_id, name}]` și `publication` (vezi mai sus).

### POST /albums/:id/photos
`photos.upload`. Multipart, câmp `files` (multiplu, până la 20). Fiecare fișier ≤ 25 MB,
validat după magic bytes (JPEG/PNG/HEIC pentru imagini; mimetype pentru video mp4/quicktime/webm/
3gpp — containerele video nu au un magic byte unic de verificat). Răspuns: array de poze create.

---

## O poză — `/api/photos/:id`

### POST /:id/tags — body `{ member_id }`
Permis uploaderului propriei poze, sau MANAGERS (`photos.tag_any`).

### DELETE /:id/tags/:memberId
Aceeași regulă ca mai sus.

### DELETE /:id
Uploaderul își șterge propria poză; altfel LEADERS (`photos.delete_any`). Șterge și fișierele de
pe disc.

### POST /:id/publish — body `{ published: boolean }` — LEADERS (`photos.publish`, Art. 59.5)
La `published: true`, respinge cu `FORBIDDEN` + mesajul/articolul din `photoPublication()` dacă
poza nu e publicabilă chiar acum.

### POST /:id/report — Art. 59.4 ("context privat")
Orice membru cu `photos.view` poate raporta; notifică toți LEADERS prin `services/notifications`.

### GET /:id/file — original, autorizat (nu static)
Uploaderul sau LEADERS (`photos.publish`). Oricine altcineva → 403.

### GET /:id/thumb — thumbnail, autorizat
Oricine cu `photos.view`. Cade pe originalul dacă nu există thumbnail.

---

## Consimțământ (Art. 59) — `/api/photos/consent`

### GET /consent/me
`{ approved, withdrawn, publishable, article, message }` pentru cel care cere (folosit și de
pagina Documente pentru a decide dacă arată butonul de retragere).

### POST /consent/withdraw — Art. 59.3
Retrage acordul propriu, efectiv **de acum încolo** (nu retroactiv). Orice poză existentă în care
membrul e etichetat devine nepublicabilă la următoarea citire.

---

## LEADERS — `/api/photos/unpublishable`
`photos.publish`. Toate pozele care NU pot fi publicate acum (listă completă, nu doar cele deja
marcate `published`), fiecare cu `publication.message` (text exact, Art. 59).

---

## Import WhatsApp (gateway, design §7) — `POST /wa/media`

Nu necesită `crocoai_token` — aceeași gardă ca `/wa/incoming`: header `x-wa-secret` =
`WA_SHARED_SECRET`, respinsă dacă apare `cf-connecting-ip` (nu trebuie să treacă prin tunelul
public). Body: `{ msgId, from, groupId, mediaType: "image"|"video", mimetype, filename, caption,
data /* base64 */ }`, max 25 MB (limita globală `express.json` a fost crescută la 40 MB pentru a
încăpea base64-ul). Grup neurmărit → 403. Idempotent pe `msgId`. Stochează poza/videoclipul într-un
album lunar al grupului (`wa_group_id` + luna curentă, creat automat), atribuit expeditorului dacă
telefonul lui corespunde unui membru (altfel `uploaded_by: null`).

### Hook în `/wa/incoming` (design §7)
Pentru mesaje din grupuri **urmărite** cu `hasMedia: true` și `mediaType` `image`/`video`, răspunsul
include `want_media: true` (gateway-ul face apoi `POST /wa/media`). Mesajele doar-media (fără text)
nu ajung niciodată la agentul AI, indiferent de `mentioned`/`quotedFromMe`. Restul fluxului
`/wa/incoming` (text, ownership, AI) e neschimbat.

---

## Tool-uri AI (`ai/tools-photos.js`)

- `acordul_meu_foto` — ca `GET /api/photos/consent/me`, formatat text.
- `pozele_mele` — pozele celui care scrie, cu starea de publicare a fiecăreia.
- `poze_nepublicabile` — doar LEADERS (`photos.publish`), ca `GET /api/photos/unpublishable`.

Teste de paritate tool ↔ rută: `app/test/photos-ai-consistency.test.js`.

---

## Decizii / abateri

- Nicio nouă cheie în `policy.js`/`rules.js` nu a fost necesară — `photos.*` și `photoPublication()`
  existau deja din Faza 2 design (§2, §3).
- Limita globală `express.json` din `server.js` a crescut de la 5 MB la 40 MB, exclusiv pentru
  a permite `POST /wa/media` (bază64 a unui fișier de 25 MB ≈ 34 MB codificat). Singura altă
  modificare în `server.js`/`wa-incoming.js` e montarea rutei și hook-ul `want_media` descris mai sus.
- Videoclipurile nu primesc thumbnail (design §5 acceptă explicit asta); grila le arată cu un
  element `<video>` mut în loc de imagine.
- Validarea video se face doar după `mimetype` declarat (mp4/quicktime/webm/3gpp) — containerele
  video nu au un magic-byte unic de verificat ca JPEG/PNG/HEIC; imaginile rămân validate strict
  după conținut.
