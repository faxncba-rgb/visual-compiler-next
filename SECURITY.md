# Security and privacy

The clinical runtime never imports or depends on OpenAI. It runs with `OPENAI_API_KEY` absent, blocks HTTP and WebSocket traffic to OpenAI domains, blocks service workers, performs no LLM repair, and reports `llmCalls: 0` and `openAIRequests: 0`.

Compilation is permitted only in training mode after complete, unexpired synthetic-data attestation and verification of a locally configured synthetic marker. Clinical compilation is refused by the backend, not merely hidden in Studio.

The redaction boundary excludes input, textarea, and contenteditable values; selected values; cookies; local/session storage; request headers; credentials; tokens; form payloads; network responses; screenshots; sensitive URL parameters; and marked sensitive nodes. Reports contain counts only and never removed values.

Browser profile state must live outside Git under `~/Library/Application Support/Visual Compiler Next/browser-profiles/`, with directories at mode `0700` and files at `0600`. Codex and repository tooling must never read these directories or emit their contents in logs. Studio will provide explicit deletion; until that UI is implemented, the operator may close Studio and manually remove the selected profile directory. Training and clinical profiles must never share state.

Run `npm run test:security` before every push. It detects probable secrets and forbidden session files, enforces the runtime import boundary, and exercises network safeguards. Do not attach credentials, sessions, screenshots, or patient information to a report.
