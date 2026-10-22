# CrocoAI — aplicațiile de iOS și Android (design, 2026-10-22)

## De ce
Membrii folosesc deja CrocoAI de pe telefon, din browser sau ca PWA. Luca vrea aplicații „adevărate”, care fac
**exact ce face versiunea web de pe telefon** și adaugă **notificări push**. Pe lângă ele, aplicațiile rezolvă
lucrurile pe care browserul nu le poate face bine, mai ales înregistrarea ședinței cu ecranul blocat.

**Distribuția** (decizia lui Luca):
- **Android:** fișier APK, trimis direct membrilor, fără Play Store.
- **iOS:** TestFlight, din contul de Apple Developer al lui Luca.

## Obiective
1. **Paritate totală cu web-ul de pe telefon.** Aplicația încarcă platforma live
   (`https://crocoai.perpetuummobile.tech`), deci orice schimbare pe server apare imediat, fără versiune nouă de
   aplicație. Un singur cod de interfață, același SPA.
2. **Notificări push** pe iOS și Android pentru tot ce produce azi o notificare în platformă (clopoțelul) sau un
   mesaj personal pe WhatsApp.
3. **Înregistrarea ședinței continuă cu ecranul blocat sau cu aplicația în fundal.** Dacă telefonul se oprește, se
   pierd cel mult ultimele câteva minute (vezi §4).
4. **Notificarea deschide pagina potrivită:** tema, ședința, taskul (câmpul `link` al notificării).
5. **Numărul de pe iconiță:** notificări necitite + teme de făcut sau de refăcut.
6. **Scurtătura „Scanează prezența”:** apăsare lungă pe iconiță (Quick Actions pe iOS, App Shortcuts pe Android)
   deschide direct camera pentru codul QR al ședinței.
7. **Deblocare cu Face ID, Touch ID sau amprentă** la deschiderea aplicației. Opțională, din setări, implicit oprită.
8. **Actualizare APK din aplicație pe Android.** La pornire aplicația compară versiunea ei cu ultima publicată pe
   server. Dacă există una nouă, propune descărcarea și instalarea. Pe iOS, TestFlight face asta singur.

## Ce nu intră
- **Fără App Store sau Play Store public.** Doar APK și TestFlight.
- **Fără interfață nativă rescrisă.** Ecranele sunt cele din SPA.
- **Fără mod offline complet.** Rămâne ce are PWA-ul: pagina offline.
- **Fără widget-uri pe ecranul principal.**
- **Fără Web Push pentru PWA** în acest proiect. Se poate adăuga separat mai târziu.

## Anti-obiective (ar fi un eșec chiar dacă „merge”)
- O a doua versiune a interfeței, care rămâne în urmă față de web.
- O notificare primită de două ori (push + WhatsApp), sau deloc.
- O înregistrare pierdută pentru că telefonul s-a blocat.
- Membri blocați afară: login care nu ține sesiunea, sau Face ID fără o cale de rezervă.
- Să pierdem regula de aur. Permisiunile rămân doar în `policy.js`. Aplicația nu știe de roluri.

## Constrângeri
- **Codul:** în repo-ul existent, într-un director nou `mobile/`. Serverul rămâne `app/`. Se exclude din exportul
  public doar dacă conține date private, ceea ce nu e cazul.
- **Build-ul** se face pe Mac-ul lui Luca: Xcode pentru iOS, Gradle/Android Studio pentru Android.
- **iOS:** identificatorul aplicației ține de contul lui Luca. Sunt necesare o cheie APNs (.p8), cu Key ID și
  Team ID, și grupul de testeri TestFlight.
  - **Testerii externi**, pe link public, cer Beta App Review. O aplicație care doar încarcă un site riscă respingere
    (ghidul 4.2). Funcțiile native de mai sus (push, înregistrare în fundal, scurtături, biometrie) sunt și argumentul
    pentru review.
  - **Distribuție (decis de Luca): link public TestFlight**, deci fiecare build trece prin Beta App Review. Prima
    versiune trimisă la review trebuie să aibă deja funcțiile native (push, înregistrare în fundal, scurtătură QR,
    Face ID), ca să nu fie respinsă ca „doar un site”.
  - Build-urile TestFlight **expiră după 90 de zile**, deci trebuie urcat un build nou cel puțin o dată la 90 de zile
    (de notat în operare).
- **Android:** instalarea APK-ului cere „surse necunoscute”. APK-ul e semnat cu o cheie proprie, păstrată în vault
  și cu copie de rezervă: dacă se pierde, actualizările nu se mai pot instala peste versiunea veche.
- **Securitate:** CSP-ul și cookie-urile de sesiune rămân cum sunt. Aplicația nu ține parola. Tokenul push nu dă
  acces la nimic, doar identifică dispozitivul.

## Cum (decis)
- **Tehnologia (decizia mea):** Capacitor, cu SPA-ul încărcat de la URL-ul live (`server.url`), plus pluginuri
  Capacitor pentru push, biometrie, scurtături, numărul de pe iconiță, înregistrare audio nativă, versiune/instalare.
  Alternativa (React Native sau aplicație nativă) ar fi însemnat a doua interfață, adică exact anti-obiectivul.
- **Push — totul de pe Junioru, fără Firebase/Google (decis de Luca, 2026-10-22):**
  - **iOS:** CrocoAI trimite direct la APNs, prin HTTP/2 cu JWT ES256 și fără dependențe, ca în
    `~/raft/server/push/apns.js` pe Junioru, codul de referință. Folosește cheia APNs a echipei Apple `RK92XXY52G`
    (Key ID `W6A3DD2PX2`, cheia „Raft Push”, valabilă pentru orice aplicație din echipă; topic = bundle ID-ul
    CrocoAI). Detaliile sunt în vault. Build-urile și TestFlight se automatizează cu cheia App Store Connect
    (`77L7Q6F29Z`, `~/Claude/scripts/asc.py`).
  - **Android:** server **ntfy** propriu pe Junioru (container Docker), expus prin tunelul Cloudflare pe un subdomeniu
    (ex. `push.crocoai.perpetuummobile.tech`).
    - Aplicația Android ține o conexiune permanentă cu ntfy printr-un serviciu în prim-plan, cu notificarea
      permanentă „CrocoAI conectat”. Pornește la boot și se reconectează singură. La prima pornire cere excepția de
      la optimizarea bateriei.
    - Fiecare dispozitiv are un topic aleator, de cel puțin 32 de caractere, generat de server. Doar CrocoAI poate
      publica pe el: ntfy are acces implicit „deny”, cu un token de scriere doar pentru CrocoAI. Abonarea se face
      doar cu numele secret al topicului.
    - ntfy ține mesajele în cache câteva ore, ca un telefon care s-a reconectat să le primească pe cele pierdute.
    - Conținutul notificării e minim: titlu scurt și link. Detaliile se văd după ce deschizi aplicația.
  - **Dezavantaj acceptat de Luca:** pe unele telefoane (Xiaomi, Samsung, Huawei) sistemul poate opri conexiunea,
    iar aplicația ține notificarea permanentă și consumă puțin mai multă baterie.
  - **Protecția:** aplicația Android trimite un semnal „sunt conectat” la CrocoAI periodic (WorkManager, ~15 min). Un
    dispozitiv Android fără semnal de mai mult de `rules.PUSH_ANDROID_STALE_MS` (implicit 3 ore) nu contează ca
    accesibil, iar mesajele lui pleacă pe WhatsApp.
- **Push sau WhatsApp (decis de Luca, 2026-10-22: push-ul înlocuiește):**
  - Un membru cu cel puțin un dispozitiv cu push activ primește notificările personale **doar prin push**: remindere,
    temă nouă, rezultat la predare, ședință programată sau mutată, cereri de aprobat.
  - **WhatsApp rămâne** pentru membrii fără aplicație, pentru codurile de verificare la înscriere, pentru mesajele pe
    grupuri (Anunțuri etc.) și pentru botul AI.
  - **Rezervă:** dacă push-ul eșuează (token APNs invalid, ntfy inaccesibil, dispozitiv Android fără semnal recent), mesajul pleacă pe WhatsApp, ca acum.
  - Pentru asta, toate trimiterile personale de azi trec printr-o singură funcție de livrare, a cărei decizie se
    face într-un singur loc în domain:
    - **unde se trimit azi:** `reminder-scheduler`, `assignment-notify`, `meeting-schedule`, `announcements`,
      `applications`, `completion`, `members`, `onboarding`, `ai-usage`, `notifications.notifyCrisisSignal`;
    - **ce face funcția:** creează notificarea în platformă, apoi trimite push sau WhatsApp.
- **Când un push contează ca nereușit (decizia mea):** se trimite pe WhatsApp în locul push-ului dacă:
  - aplicația a raportat că notificările sunt oprite din setările telefonului (raportează la fiecare pornire și
    revenire în prim-plan);
  - dispozitivul n-a mai deschis aplicația de 30 de zile (probabil dezinstalată; `rules`);
  - APNs respinge tokenul, ntfy nu răspunde sau dispozitivul Android n-a mai trimis semnalul „sunt conectat”.

  Fără confirmări de citire și fără cronometre. Alertele de criză (`notifyCrisisSignal`) pleacă **și** pe push,
  **și** pe WhatsApp, întotdeauna.
- **Sesiunea (decizia mea):** cookie-ul de sesiune se reînnoiește la folosire (fereastră glisantă de 30 de zile), pe
  web și în aplicație. Delogarea rămâne cum e acum: încheie sesiunile pe toate dispozitivele și șterge tokenurile
  push ale membrului, ca să nu mai primească push cineva care s-a delogat.
- **Face ID (decizia mea):** dacă biometria eșuează sau e blocată, se cere codul telefonului (prin sistem). Dacă
  nici asta nu merge, se afișează login-ul CrocoAI.
- **Dispozitive:** tabel nou cu tokenurile push per membru și per dispozitiv (platformă, versiunea aplicației,
  ultima folosire). La logout, tokenul dispozitivului se șterge. Tokenurile respinse de APNs se șterg automat.
  Ștergerea contului sau ieșirea din echipă șterge tokenurile, cu regulă de retenție în `rules.RETENTION`.
- **Setări (decizia mea):** pe „Contul meu”, în aplicație, apar:
  - „Notificări push” (pornit sau oprit pe acest dispozitiv);
  - „Deblocare cu Face ID / amprentă”.

  Fără preferințe pe tip de notificare în prima versiune.
- **Numărul de pe iconiță:** calculat de server, trimis odată cu fiecare push și actualizat când aplicația
  revine în prim-plan.
- **Înregistrarea nativă:** aplicația înregistrează cu un plugin nativ, cu modul de fundal audio pe iOS și un
  serviciu în prim-plan pe Android, cu notificarea „Înregistrare în curs”. În browser rămâne codul de azi
  (MediaRecorder pe bucăți).
- **Actualizare Android:**
  - Serverul publică ultima versiune: `GET /api/app/android` → `{ version, url, notes }`.
  - APK-ul stă pe server și se descarcă doar autentificat, sau din releases pe GitHub-ul privat. Alegerea rămâne
    la builder.
  - Aplicația descarcă APK-ul și deschide instalatorul de sistem.

## Lăsat la latitudinea celui care construiește
- Pluginurile Capacitor exacte (oficiale sau din comunitate), cu condiția să fie întreținute.
- Formatul audio nativ și cum se urcă: pe bucăți, în timpul înregistrării, sau pe segmente de câteva minute. Cerința
  e §Obiective 3: dacă telefonul moare, se pierd cel mult câteva minute. Serverul se adaptează, de exemplu cu un
  format nou de bucăți sau cu mai multe segmente concatenate la final cu ffmpeg (deja în imagine).
- Cum află SPA-ul că rulează în aplicație (`Capacitor.isNativePlatform()`) și ce ascunde în acest caz: de exemplu
  butonul „Instalează aplicația”.
- Iconițele și ecranul de pornire, din iconițele PWA existente.
- Cum se face build-ul: scripturi `npm run build:android` și `build:ios`, plus instrucțiuni în `docs/`.

## Teste
- **Server:** livrarea push sau WhatsApp și rezerva, înregistrarea și ștergerea tokenurilor, calculul numărului de pe
  iconiță, endpoint-ul de versiune Android, plus testele de politică (cine poate înregistra un dispozitiv: doar el
  pentru el). APNs și ntfy sunt mereu simulate în teste.
- **Pe dispozitive reale,** un Android și un iPhone (lista de verificare în `docs/`):
  - login și sesiune care rămâne;
  - push cu aplicația închisă, deschiderea linkului din notificare;
  - înregistrare de 10 minute cu ecranul blocat;
  - scurtătura QR, Face ID cu fallback la parolă, numărul de pe iconiță;
  - actualizare APK de la o versiune la alta.

## Ce trebuie de la Luca înainte de build
- Nimic pentru iOS: cheile sunt în vault. Bundle ID propus: `tech.perpetuummobile.crocoai` (de înregistrat în
  contul Apple, prin API-ul App Store Connect sau din portal).
- Pentru Android: subdomeniul pentru ntfy pe tunelul Cloudflare și keystore-ul de semnare a APK-ului, care se
  generează și se salvează în vault.
