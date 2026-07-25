# Changelog

## Unreleased

- Added visible fixture, NCBA training, and NCBA clinical profile selection in Studio.
- Added explicit managed-browser opening with isolated local state and no automatic navigation.
- Enforced fresh synthetic-data attestation before capture or compilation and technical clinical compilation/capture denial.
- Added the visible fixture lifecycle journey from redacted capture through promoted A/B execution, including redaction, fingerprint, preflight, and zero-call telemetry panels.
- Added fixture-only tests proving profile selection makes no NCBA request.
- Allowed dynamic same-origin NCBA training paths and query parameters while canonicalizing compiler, artifact, fingerprint, and audit URLs to `origin + pathname`.
- Added attestation-gated managed-browser opening, local target validation, and Playwright cross-origin navigation blocking.
- Added an explicit `AUTHENTICATION BOOTSTRAP → APPLICATION LOCKED` managed-browser flow for manual SSO.
- Kept capture and compilation closed during bootstrap, added an exact-origin human lock, and resumed strict primary-navigation enforcement after lock.
- Added a two-origin synthetic SSO fixture covering redirect, popup, cross-origin iframe exclusion, query/token redaction, OpenAI blocking, and post-lock escape blocking.
- Replaced the fixture-only compiler boundary with a classified value-free semantic payload containing accessibility, label, structural, DOM and visual information.
- Added exact payload preview and SHA-bound human confirmation before Training compilation.
- Added ranked locator fallbacks that work without test attributes, per-step candidate diagnostics, and count-only zero-candidate explanations.
- Added a professional CGI-style local fixture with duplicate textareas/buttons and an offline fill-then-save E2E replay.
- Replaced the large `/api/compile` response with a compact acknowledgement and separate `GET /api/workflow` load.
- Added visible compile stages, OpenAI/frontend timeouts, double-click and concurrent-call refusal, and SHA-256 idempotency reuse.
- Persisted lifecycle Draft state and idempotency manifests in restricted local sidecars, including compatible human-confirmed restoration after Studio restart.
- Added a restart E2E proving that a simulated artifact larger than 100 KB is saved, compactly acknowledged, reloaded, restored, and displayed without an infinite busy state.

## 0.2.0 — 2026-07-22

- Started the post-hackathon repository while preserving Build Week history.
- Added synthetic-to-clinical Application Profiles, browser-mode separation, attestation, redaction, fingerprints, workflow lifecycle, preflight, redacted audit, and ephemeral runtime parameters.
- Added the synthetic NCBA technical fixture with layouts A/B.
- Added security tests and fixture-only GitHub Actions CI.
- Documented that no real DPI, patient data, clinical workflow, or OpenAI call was used.
