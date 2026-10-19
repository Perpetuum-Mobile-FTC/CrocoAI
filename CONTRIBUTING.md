# Contributing

Issues and pull requests are welcome, especially from other FTC teams adapting CrocoAI.

- Run `npm test` in `app/` before opening a pull request. Every change needs tests.
- Keep the golden rule. Permissions go in `src/domain/policy.js` (with a row in `test/policy-matrix.test.js`),
  and rules and thresholds go in `src/domain/rules.js`. Routes and AI tools only call services. A new AI tool needs
  a row in `test/_ai-parity.js`.
- Schema changes go in a new numbered migration in `src/db/migrations/`. Never edit a migration that has already shipped.
- The UI is in Romanian, and code, comments and commit messages are in English.
- Never commit real personal data, phone numbers or secrets. Use fake numbers such as `4070000xxxx` in tests.
- Keep the attribution on the login page and in NOTICE.md (license requirement).
