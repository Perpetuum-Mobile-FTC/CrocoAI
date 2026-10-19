# CrocoAI — Lanț de rezervă AI (design, aprobat de Luca 2026-10-12)

Ordinea: **Claude principal → Claude ARPD → Qwen (server propriu) → Groq (`openai/gpt-oss-120b`)**.
Regula de aur rămâne: aceleași tool-uri (`buildToolList`), același `SYSTEM_PROMPT`, aceleași reguli din
`src/domain/ai-policy.js` (tag-uri `[REFUZ:…]`/`[CRIZA]`, limite, trunchiere) — indiferent de model.

## Configurare (env, niciodată în repo)
| Furnizor | Env | Motor |
|---|---|---|
| `claude-main` | `CLAUDE_CODE_OAUTH_TOKEN` (sau `ANTHROPIC_API_KEY`), model `AI_MODEL` | Agent SDK (ca acum) |
| `claude-backup` | `CLAUDE_CODE_OAUTH_TOKEN_BACKUP`, același `AI_MODEL` | Agent SDK, alt token |
| `qwen` | `QWEN_BASE_URL`, `QWEN_API_KEY`, `QWEN_MODEL` (implicit `qwen3.8`) | OpenAI-compatibil (`/chat/completions`, tools) |
| `groq` | `GROQ_API_KEY` (există), `GROQ_CHAT_MODEL` (implicit `openai/gpt-oss-120b`) | OpenAI-compatibil, `https://api.groq.com/openai/v1` |
Un furnizor fără env e sărit. `AI_PROVIDER_COOLDOWN_MIN` (implicit 15).

## Comutare
- Se trece la următorul furnizor când apelul curent: aruncă eroare; dă rezultat non-success; sau textul/eroarea
  conține semne de limită/autentificare/supraîncărcare (`usage limit`, `rate limit`, `429`, `529`, `overloaded`,
  `401`, `authentication`, `invalid … token`, `credit balance`), ori timeout (implicit 90 s/apel).
- Furnizorul căzut intră în „cooldown”: până la ora de reset dacă mesajul o conține (ex. `usage limit reached|<epoch>`),
  altfel `AI_PROVIDER_COOLDOWN_MIN`. În cooldown e sărit fără apel. Starea e în memorie (restart = reset).
- Dacă toți furnizorii eșuează → răspunsul tehnic existent („Scuze, am o problemă tehnică…”).
- **Erorile de tool nu declanșează comutarea** (un refuz din domain e un răspuns valid).

## Motor OpenAI-compatibil (`src/ai/openai-agent.js`)
- Mesaje: `system` = `SYSTEM_PROMPT`, `user` = `buildUserTurn(...)`.
- Tool-uri: aceleași obiecte din `buildToolList` → schema JSON din schema zod (zod v4 `z.toJSONSchema`), handler-ul
  apelat identic (`handler(args, {})`), rezultatul text trimis ca mesaj `tool`. Maxim `MAX_TURNS` runde.
- `max_tokens` = `aiPolicy.maxOutputTokens()`; elimină blocurile `<think>…</think>` din text.
- Rezultatul trece prin același drum din `runAgent` (tag-uri, trunchiere, `ai_usage` cu numele real al modelului).

## Apeluri fără tool-uri
Ciorna de PV (`meetings.generateDraftText`) și rezumatul manualului FTC (`ftc-manual-updater`) folosesc același lanț
printr-o funcție comună `complete({ system, prompt, maxTokens })`.

## Vizibilitate
- La prima comutare de pe furnizorul principal și la revenire: notificare în platformă pentru Team Leader + un WhatsApp
  către Team Leader (max 1 / furnizor / cooldown), fără conținut de conversație.
- `ai_usage.model` = modelul care a răspuns efectiv (Admin → monitorizare AI îl arată deja).

## Teste
Comutare pe fiecare tip de eroare, ordinea, cooldown (inclusiv ora de reset parsată), sărirea furnizorilor neconfigurați,
erorile de tool fără comutare, motorul OpenAI cu server simulat (tool-call → rezultat → răspuns final, `<think>` eliminat,
tag-uri aplicate), notificarea o singură dată. SDK-ul real și rețeaua reală nu sunt apelate în teste.
