# Changelog

## 0.1.0

Initial release.

- Graph memory (Observations / Retrieval / Substrate tiers), scoped per workspace
- File, search, POSIX shell, real shell, browser and MCP tools
- Anthropic and OpenAI-compatible providers (OpenAI, OpenRouter, DeepSeek, Mistral,
  Groq, xAI, Together, Fireworks, Cerebras, Ollama, LM Studio, vLLM, Voyage, or any
  OpenAI-compatible endpoint), with per-role provider/model binding and reasoning-effort
  control
- Autonomous task queue backed by SQLite, with a supervisor loop that retries, splits
  or rolls back tasks until every one verifies — no attempt limit, no terminal failure
- Executor-owned validation: executors run code, commands, tests, and browser checks,
  persist structured evidence in SQLite, and tool-less supervisors only judge that evidence
- Project instructions from `AGENTS.md`, `CLAUDE.md`, or `.mfagent/instructions.md`
- Optional notify command on autonomous-run completion
