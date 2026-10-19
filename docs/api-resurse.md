# API Resurse (bibliotecă comună de fișiere și linkuri)

Toate rutele cer autentificare. Logica e în `app/src/services/resources.js`; tool-ul AI `cauta_resurse`
apelează același serviciu. Fișierele stau în `app/data/resources/` (env `RESOURCES_DIR`), max 50 MB
(`RESOURCE_MAX_FILE_SIZE` în `rules.js`), servite doar prin endpoint autorizat.

Permisiuni (`policy.js`): `resources.view` = membri activi/pauză/alumni + conducere/mentori;
`resources.manage` = team_leader, co_leader, head_tech, head_nontech, mentor, doar cu status `activ`.
Categorii: `RESOURCE_CATEGORIES` din `rules.js` (regulamente, sponsorizari, pr, programare, mecanica, proiectare, organizare, altele).

| Rută | Descriere |
|------|-----------|
| `GET /api/resources?q=&category=` | `{ categories:[{key,label}], can_manage, resources:[{ id, category, title, description, kind, url\|null, file:{name,mime,size}\|null, created_by_name, created_at, updated_at, sort_order }] }`. Sortat după ordinea categoriei, `sort_order`, titlu. `q` caută în titlu/descriere/nume fișier, fără diferență de majuscule/diacritice. |
| `POST /api/resources` | JSON `{kind:"link", category, title, description, url}` sau multipart (`file`, `category`, `title`, `description`) → `201 { resource }`. Titlul lipsă la fișier = numele fără extensie. |
| `PUT /api/resources/:id` | JSON parțial `{category,title,description,url,sort_order}` → `{ resource }` (`url` doar pentru linkuri). |
| `POST /api/resources/:id/file` | multipart `file`; înlocuiește fișierul (doar kind=file) → `{ resource }`. |
| `DELETE /api/resources/:id` | `{ ok: true }` (șterge și fișierul). |
| `GET /api/resources/:id/file` | Fișierul. `inline` pentru pdf/png/jpeg/gif/webp/text simplu, altfel `attachment`; `?download=1` forțează `attachment`. `filename*` UTF-8. |

Erori: `{ error, article, code }` — `INVALID` 400 (categorie/titlu/url/fișier), `FORBIDDEN` 403, `NOT_FOUND` 404.
