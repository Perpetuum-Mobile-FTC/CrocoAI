# CrocoAI — Pachet B: Acasă nouă, anunțuri, bug-uri din audit (aprobat de Luca 2026-10-16)

Regula de aur rămâne: permisiuni doar în `src/domain/policy.js`, logică în servicii, UI subțire.

## B1. Acasă = pagina personală (de sus în jos)
1. **Termene** — numărătoare inversă: termene ale echipei (`deadlines`: titlu, dată, opțional „dată neanunțată” cu text
   „ianuarie–februarie 2027”), gestionate de TL/co-leader/șefi în Admin → „Termene”. Pre-populate la migrare:
   „Termen înscriere membri pe natie.ro” — 17.01.2027; „Etapa Regională” — dată neanunțată („ianuarie–februarie 2027”).
   Afișare: „Mai sunt N zile” / „azi” / „dată neanunțată”; trecutele dispar.
2. **Anunțuri** — ultimele anunțuri (titlu, text, autor, dată), „Vezi toate” → listă. Le publică TL/co-leader/mentori
   (toată echipa) și șefii (pentru departamentul lor → văzute doar de departament + „ambele”). La publicare: notificare
   în platformă destinatarilor + opțional mesaj pe grupul de Anunțuri (bifă „Trimite și pe WhatsApp”, doar pentru toată
   echipa). Anunțul automat despre manualul FTC devine un anunț aici.
3. **Temele mele** — de făcut / de refăcut, cu termen (cele mai apropiate primele).
4. **To-do** — taskurile mele nefăcute (cu 🔔 dacă au reminder), bifare direct.
5. **Ședințele mele viitoare** (existent).
6. **Prezența mea** (existent) și **Documente lipsă** (existent, compact).
- Conducere: un rând „De verificat” sus: predări care așteaptă verificarea (pe drepturile lor), cereri de rol, cereri de motivare.
- Pe telefon: carduri compacte (statisticile pe grilă de 3, fără dubluri).

## B2. Chat echipă — eliminat complet
Se șterg rutele, serviciul, tool-urile AI și acțiunile `chat.*` din policy; datele vechi (anunțuri din canalul
„Anunțuri”) se migrează în tabela nouă de anunțuri; celelalte conversații rămân în DB doar ca istoric (fără UI).

## B3. Bug-uri din audit
- Notificări: afișează titlu + text + dată formatată; click → `link`.
- Calendar: evenimentele care aparțin unei ședințe nu se pot modifica/șterge din Calendar (doar din Ședințe; ✎/× ascunse,
  serverul refuză); `events.list` expandează seriile săptămânale (fiecare apariție, din sesiuni) — Calendar, Acasă, bot.
- Google Meet: „Generează link automat” repar (ora/fusul corect, durata reală); la mutare/anulare/trecere pe fizic
  evenimentul Google se actualizează/șterge (best-effort).
- Remindere de eveniment re-armate când se schimbă ora unui eveniment/ședințe.
- Ciorna PV: locul real (sala / Meet), ședința următoare pe aceeași audiență; `deciziile_sedintei` cu mai multe ședințe
  în aceeași zi.
- Documente: fără `capture` (alegere fișier existent pe telefon).
- Poze: membrii văd poza mare (variantă medie servită lor), originalul rămâne pentru lideri/uploader.
- Scheduler: „scadent azi la 09:00” în ora României, fără WhatsApp pe telefoane neverificate.

## Teste
Fiecare punct; paritate AI ↔ rută pentru anunțuri și evenimente; test în browser (desktop + telefon) pentru Acasă pe roluri.
