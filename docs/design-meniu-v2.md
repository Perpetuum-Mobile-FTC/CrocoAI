# CrocoAI — Meniu simplificat + taskuri cu reminder (design, aprobat de Luca 2026-10-12/14)

## 1. Meniu (sidebar desktop + „Mai mult” pe telefon)
| Secțiune | Cine o vede | Tab-uri |
|---|---|---|
| Acasă | toți | — (cardurile existente + „Ședințele tale viitoare”) |
| Ședințe | TL, co-leader, șefi de departament, mentori (+ lideri de grup pentru ședințele grupului) | Ședințe (listă → ședință: prezență, înregistrare, PV) · Prezență (situația pe membri, alte sesiuni, export) |
| Teme | toți | Teme · Taskuri |
| Calendar | toți | — |
| Echipă | toți | Membri · Grupuri |
| Documente | toți | Documente · Regulament · Poze |
| Chat AI | toți | — |
| Admin | TL, co-leader | Admin · Cereri de rol |

- **Eliminate din interfață:** Chat echipă și Mesaje WhatsApp (paginile și intrările de meniu). Backend-ul lor rămâne
  (folosit de onboarding / istoric), dar nu mai e accesibil din UI. Pagina Remindere dispare (vezi §2).
- Tab-ul activ e în adresă: `/<secțiune>?tab=<tab>`. Adresele vechi redirecționează: `/prezenta` → `/sedinte?tab=prezenta`,
  `/prezenta/sesiune/:id` → la fel ca acum dar sub Ședințe, `/taskuri` → `/teme?tab=taskuri`, `/remindere` → `/teme?tab=taskuri`,
  `/membri` → `/echipa?tab=membri`, `/membri/:id` rămâne (profil), `/grupuri` → `/echipa?tab=grupuri`,
  `/regulament` → `/documente?tab=regulament`, `/poze` → `/documente?tab=poze`, `/chat-echipa` → `/chat`, `/mesaje` → `/admin`.
  Linkurile din notificări/WhatsApp deja trimise funcționează. `SPA_ROUTES` din server.js se actualizează.
- Telefon (bara de jos, 5 poziții): conducere → Acasă · Ședințe · Teme · Chat · Mai mult; membri → Acasă · Teme · Calendar · Chat · Mai mult.
- Fiecare vede doar tab-urile permise (aceleași reguli de acces ca azi).

## 2. Taskuri cu reminder (remindere unificate)
- Un task poate avea opțional **ora de reminder** (`remind_at`, dată+oră Europe/Bucharest). La ora respectivă: notificare în
  platformă + WhatsApp individual către cel căruia îi e asignat (exact ce făcea un reminder), o singură dată.
- Formularul de task: titlu, termen (dată), „Amintește-mi la” (opțional), pentru cine (managerii — ca azi).
- Remindere existente neexpediate → migrate în taskuri cu `remind_at` (titlu = mesajul, asignat = destinatarul).
  Creatorul NU se poate păstra: tabela `reminders` n-a avut coloană de creator, deci taskurile migrate au
  `created_by = NULL` (le editează doar managerii). Remindere doar cu telefon (fără membru) rămân în `reminders`
  și se trimit pe calea veche. Cele deja trimise rămân doar în istoric (tabela `reminders` nu se șterge).
- Un membru își editează taskurile create de el pentru el (titlu, termen, „Amintește-mi la”, gata) — `tasks.edit_own`;
  asignarea către alții rămâne doar pentru manageri.
- Acasă are cardul „Prezența mea” pentru toți (procent, ultimele sesiuni, cereri de motivare în așteptare, buton
  „Cere motivare”), fiindcă tab-ul Prezență e doar în meniul conducerii.
- Botul AI: „amintește-mi mâine la 17 să…” creează un task cu reminder (tool-ul de reminder devine wrapper peste taskuri);
  aceleași permisiuni (pentru alții: doar managerii).
- API vechi `/api/reminders` rămâne compatibil (creează/listează prin taskuri) până nu mai e folosit.

## 3. Teste
Redirectări (fiecare adresă veche), vizibilitatea secțiunilor/tab-urilor pe rol, task cu reminder (trimis o dată, la ora
locală corectă, peste DST), migrarea reminderelor neexpediate, tool-ul AI de reminder → task, compatibilitate `/api/reminders`.
Test în browser (desktop + lățime de telefon) pentru navigare și tab-uri.
