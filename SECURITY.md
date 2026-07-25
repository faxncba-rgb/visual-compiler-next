# Security and privacy

The clinical runtime never imports or depends on OpenAI. It runs with `OPENAI_API_KEY` absent, blocks HTTP and WebSocket traffic to OpenAI domains, blocks service workers, performs no LLM repair, and reports `llmCalls: 0` and `openAIRequests: 0`.

Compilation is permitted only in training mode after complete, unexpired synthetic-data attestation and verification of a locally configured synthetic marker. Clinical compilation is refused by the backend, not merely hidden in Studio.

The redaction boundary excludes input, textarea, and contenteditable values; selected values; cookies; local/session storage; request headers; credentials; tokens; form payloads; network responses; screenshots; sensitive URL parameters; and marked sensitive nodes. Reports contain counts only and never removed values.

Browser profile state must live outside Git under `~/Library/Application Support/Visual Compiler Next/browser-profiles/`, with directories at mode `0700` and files at `0600`. Codex and repository tooling must never read these directories or emit their contents in logs. Studio provides explicit deletion for the active clinical profile. Training and clinical profiles must never share state.

Studio now creates a separate directory per managed profile and can delete the active clinical directory explicitly. It never reads cookies or storage for the compiler. Managed-browser opening is a visible, user-triggered action; profile selection and tests never contact the configured NCBA origin. Page capture occurs only after complete fresh attestation and is transformed at the compiler boundary into roles, geometry, state, control types, and explicitly marked stable labels.

Training navigation permits dynamic paths and query strings only when `new URL(target).origin` exactly matches the configured HTTPS origin. The full navigation URL remains in memory. `patient_id`, `mytime`, and every other query parameter are removed by canonicalizing to `origin + pathname` before model input, workflow persistence, structural fingerprinting, or audit creation. Playwright blocks navigation redirects that leave the configured origin.

Run `npm run test:security` before every push. It detects probable secrets and forbidden session files, enforces the runtime import boundary, and exercises network safeguards. Do not attach credentials, sessions, screenshots, or patient information to a report.
