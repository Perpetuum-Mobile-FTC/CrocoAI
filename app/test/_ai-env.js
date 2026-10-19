// Clears every AI provider credential (docs/design-ai-fallback.md) so no test ever reaches a real
// model - e.g. inside the production container, where GROQ_API_KEY is set for transcription.
// Loaded for every test file via `node --require ./test/_ai-env.js` (package.json) and called
// explicitly by tests that assert "AI not configured".
const AI_PROVIDER_ENV = [
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP",
  "QWEN_BASE_URL", "QWEN_API_KEY", "QWEN_MODEL", "GROQ_API_KEY", "GROQ_CHAT_MODEL",
];

function clearAiProviderEnv() {
  for (const k of AI_PROVIDER_ENV) delete process.env[k];
}

clearAiProviderEnv();

module.exports = { clearAiProviderEnv, AI_PROVIDER_ENV };
