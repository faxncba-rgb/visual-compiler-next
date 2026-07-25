# Security and privacy

The clinical runtime never imports or depends on OpenAI. It runs with `OPENAI_API_KEY` absent, blocks HTTP and WebSocket traffic to OpenAI domains, blocks service workers, performs no LLM repair, and reports `llmCalls: 0` and `openAIRequests: 0`.

Compilation is permitted only in training mode after complete, unexpired synthetic-data attestation and verification of a locally configured synthetic marker. Clinical compilation is refused by the backend, not merely hidden in Studio.

The redaction boundary excludes input, textarea, and contenteditable values; selected values; cookies; local/session storage; request headers; credentials; tokens; form payloads; network responses; screenshots; sensitive URL parameters; and marked sensitive nodes. Reports contain counts only and never removed values.

Managed Studio contexts are ephemeral and memory-only. They use non-persistent Playwright contexts and are closed through Studio deletion or process shutdown; no cookie jar or Playwright storage state is written to the repository or to a browser-profile directory. Future durable manual-login profiles, if implemented, must live outside Git with restrictive permissions, remain independent by mode, and stay unread by Codex.

Studio never reads cookies or storage for the compiler. Managed-browser opening is a visible, user-triggered action; profile selection and tests never contact the configured NCBA origin. Page capture occurs only after complete fresh attestation, return to the configured origin, and explicit application lock, then is transformed at the compiler boundary into roles, geometry, state, control types, and explicitly marked stable labels.

Training navigation permits dynamic paths and query strings only when `new URL(target).origin` exactly matches the configured HTTPS origin. The full navigation URL remains in memory. `patient_id`, `mytime`, and every other query parameter are removed by canonicalizing to `origin + pathname` before model input, workflow persistence, structural fingerprinting, audit creation, or diagnostics.

During `AUTHENTICATION BOOTSTRAP`, HTTPS redirects and popups may leave the application origin for manual SSO, but capture and compilation return a closed-state error. Unsafe schemes, unencrypted HTTP, and OpenAI domains remain blocked. Studio reports only origins. The explicit lock is accepted only when the primary page is back on the configured application origin. During `APPLICATION LOCKED`, strict origin enforcement resumes for primary-page navigation. HTTPS subresources and iframe navigation remain available for application compatibility, while cross-origin frames are counted and excluded from capture. Authentication origins and parameters are never persisted in artifacts.

Run `npm run test:security` before every push. It detects probable secrets and forbidden session files, enforces the runtime import boundary, and exercises network safeguards. Do not attach credentials, sessions, screenshots, or patient information to a report.
