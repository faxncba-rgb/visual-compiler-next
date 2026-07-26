# Visual Compiler Next

**Compile on synthetic data. Execute on real workflows.**

Visual Compiler Next is the post-hackathon continuation of [the immutable OpenAI Build Week submission](https://github.com/faxncba-rgb/Visual-compiler-). Development started on **2026-07-22**. Work in this repository is not part of the original Build Week submission.

The project compiles an authorized administrative procedure from a synthetic training environment into validated Semantic IR and a deterministic Playwright workflow. A promoted artifact can then be executed locally after a fail-closed structural preflight. Patient data must never be sent to GPT-5.6.

```text
Synthetic training application
→ redacted page model
→ GPT-5.6 compilation
→ validated Semantic IR
→ deterministic workflow
→ validation → human approval → promotion
→ clinical structural preflight
→ local deterministic runtime
→ zero OpenAI calls
```

## Current MVP

- Strongly typed Application Profiles, including `ncba-dpi` and the local `ncba-dpi-fixture`.
- Visible Studio selection for `ncba-dpi-fixture`, `ncba-dpi-training`, and `ncba-dpi-clinical`; selecting a profile never opens its URL.
- Separate visible training and clinical browser-profile definitions.
- Strict target URL allowlists, protocol and credential checks, redirect checks, and default SSRF denial.
- Mandatory, expiring synthetic-data attestation with a locally verified synthetic marker.
- Page-model redaction excluding values, storage, cookies, network data, sensitive URL parameters, and sensitive nodes.
- Classified semantic compiler payload retaining only control names, associated labels, generic placeholders/control text, nearby structural headings, geometry and DOM/visual relations.
- Exact redacted-payload preview plus mandatory human confirmation before any Training compilation.
- Compact compile acknowledgements followed by explicit artifact loading, visible stage progress, bounded requests, concurrent-call refusal, and idempotent artifact reuse.
- Data-independent structural fingerprints and redacted compatibility differences.
- `Draft → Validated → Approved → Promoted → Revoked` lifecycle with immutable SHA-256 verification.
- Fail-closed clinical preflight, redacted audit structures, and ephemeral runtime parameters.
- Local `ncba-dpi-fixture` with fictitious login, synthetic banner, administrative table, and layout variants A/B.
- Promoted-only runtime entry point validated by a full synthetic workflow replay on fixture variants A/B.
- Existing Build Week safeguards: no OpenAI import in runtime, OpenAI HTTP/WebSocket blocking, service workers blocked, `llmCalls: 0`, and `openAIRequests: 0`.
- An optional compatibility-probe contract that is disabled by default and has not been run.

## Managed application profiles

Studio starts on `ncba-dpi-fixture`. The target URL is constrained by the selected profile. `ncba-dpi-training` and `ncba-dpi-clinical` show the configured NCBA origin but do not contact it when selected. Only the explicit **Open in managed browser** action can open that origin, in a visible ephemeral Playwright context after an additional confirmation.

Training capture and compilation require every synthetic-environment attestation statement plus a locally verified synthetic marker. The backend returns `403` before capture when attestation is missing or expired. External training compilation can use only the page already opened manually in its managed browser. Clinical mode hides training controls and rejects compilation and compiler-oriented capture at the policy layer.

The compiler boundary receives only the reviewed value-free semantic payload. It does not receive cookies, authentication tokens, input or textarea values, contenteditable values, browser storage, headers, form payloads, or network responses.

The compiler boundary no longer depends on fixture-only test attributes. For visible interactive controls it may retain computed accessible names, associated labels, resolved `aria-labelledby`, `aria-label`, generic placeholders, button/link/option text, nearby structural headings, bounding boxes, state, and deterministic DOM/visual order. Every retained text is classified as `interface-label`, `control-name`, or `structural-heading`; removed values and arbitrary content appear only as count-based `redacted-value` / `excluded-content` markers. Studio shows the exact canonical JSON payload and requires an explicit review checkbox before `/api/compile` will proceed.

The managed Training flow has two explicit phases. During **AUTHENTICATION BOOTSTRAP**, temporary HTTPS redirects, popups, iframe navigation, and subresources may cross origins so the user can authenticate manually. Capture and compilation stay technically disabled, OpenAI domains and unsafe schemes remain blocked, and Studio displays only the current origin. When the primary page returns to the exact configured application origin, the user must choose **Authentication complete — lock to application**. **APPLICATION LOCKED** then rejects main-page navigation away from that origin while allowing required HTTPS subresources and iframes; cross-origin frames are excluded from capture.

The NCBA training profile allows any HTTPS pathname and dynamic query string on the exact configured origin. The full URL exists only in memory for browser navigation. Before compiler input, persistence, fingerprinting, audit output, or diagnostics, it is canonicalized to `origin + pathname`; all query parameters and fragments are discarded. Authentication origins are never written to workflow artifacts.

On the local fixture, Studio visibly demonstrates the complete milestone: redacted capture, mock compilation, `Draft → Validated → Approved → Promoted`, structural preflight, and promoted execution on variants A and B. Redaction counts, the structural SHA-256, planned actions, preflight result, and zero-call runtime telemetry remain visible. `Revoked` is also exposed and immediately closes promoted execution.

Draft and subsequent lifecycle state are persisted locally in restricted sidecars containing hashes, canonical URLs, structural fingerprints, profile identifiers, and timestamps but no browser or medical data. Studio restores validated sidecars on restart and can rebind a compatible artifact to a fresh confirmed capture without GPT. Artifact bytes remain immutable and are loaded separately through `GET /api/workflow`; the compile POST returns only identifiers, lifecycle state, and summarized diagnostics. Ed25519 signing is deferred; promoted artifacts use verified SHA-256.

For an authorized synthetic Training session, a restored Draft can be tested directly on the already open `APPLICATION LOCKED` page. Studio first displays the workflow-provided values, selected locators, and a fail-closed local preflight. The separate **Test run on locked Training page** control requires explicit confirmation, performs no retry, never launches another browser, and may transition only `Draft → Validated`. It never approves or promotes automatically. Run A/B remain local Build Week fixture replays and must not be used for the managed Training page.

## Local Lab Mode

`VISUAL_COMPILER_LAB_MODE=true` enables a deliberately local-only Training shortcut. It is active only when Studio binds to `127.0.0.1`, `localhost`, or `::1`, the selected profile is Training or the local fixture, and the operator has confirmed once that the browser session contains synthetic test records only. It is never available in Clinical mode.

Lab Mode keeps the privacy and runtime boundaries while removing repeated prototype confirmations. Its top-of-Studio journey is **Browser → Locked → Captured → Compiled → Ready → Running → Passed / Failed**, with **Capture now**, **Compile**, **Run on current page**, **Run again**, **Recapture and compile**, **Stop**, and **Reset test session**. Capture is refreshed automatically only when the canonical page or structural fingerprint changed. Compilation still occurs only after a human click; a compatible artifact is restored with `modelCalls: 0`.

The existing-page runtime tests the selected primary locator against Playwright first, including visibility, enabled state, editability, readonly state, control type, and same-origin frame identity. A visible `readonly` textbox is not actionable. For `fill`, the runtime may select one deterministic editable fallback using only workflow semantics, associated labels, structural headings, same-container action anchors, and DOM order; an ambiguous result fails closed. Legacy `<a onclick>` controls without `href` are not misclassified as accessible links, handler source is never retained, and a unique text/DOM fallback may be scoped to the previous step's form or section before any ordinal fallback. Same-origin frames are captured and resolved with redacted identity; cross-origin frames are excluded from compiler input.

Lab `fill` uses short, verified strategies in order: Playwright fill for standard inputs/textareas or `contenteditable`, focused keyboard input, then—only in local Lab Mode—a native input/textarea value setter that refuses readonly/disabled controls and dispatches `input`, `change`, and blur. Every attempt is followed by an exact control-value check. A fill `text-visible` postcondition that actually represents the entered value is normalized to an input-value assertion rather than incorrectly searching page text. Studio shows the redacted phases **Resolving target**, **Checking editability**, **Filling field**, **Verifying entered value**, **Resolving Enregistrer**, and **Clicking Enregistrer**; telemetry never contains the entered value.

Failures are bounded and classified without page data: selected element not editable, no unique editable target, fill timeout, or entered-value verification failure. Execution stops before the next action, so a failed fill cannot click **Enregistrer**. **Run again** remains available after a completed failure when the managed page/session is still compatible; it does not recapture, recompile, or call OpenAI.

To test or restore existing artifacts with no model call:

```bash
VISUAL_COMPILER_LAB_MODE=true USE_LIVE_OPENAI=false STUDIO_HOST=127.0.0.1 npm run dev
```

To permit a new, explicit human-clicked compilation in an authorized synthetic session:

```bash
VISUAL_COMPILER_LAB_MODE=true USE_LIVE_OPENAI=true OPENAI_COMPILE_MODEL=gpt-5.6 STUDIO_HOST=127.0.0.1 npm run dev
```

No API key belongs in either command, the repository, Studio, or documentation. Live compilation remains a separately authorized operator action; it is never used by tests.

## Local use

```bash
npm ci
npm run build
npm test
npm run test:security
npm run test:e2e
npm run dev
```

Studio: `http://127.0.0.1:3000`
Synthetic fixture: `http://127.0.0.1:4173/ncba-fixture?mode=training&variant=A`

CI and tests use local fixtures only. They require no OpenAI key and never contact the NCBA DPI.

The SSO regression test uses two loopback origins: a synthetic application and a synthetic identity provider. Its HTTP exception is available only when `ALLOW_EXPLICIT_LOCAL_SSO_FIXTURE=true` and the configured application origin is loopback. Production profiles remain HTTPS-only.

The local `/cgi-professional` fixture intentionally contains multiple textareas and multiple **Enregistrer** buttons without `data-vc-stable-label`. Its offline test instruction compiles through ranked accessibility, label, DOM and spatial candidates, then replays locally with zero OpenAI calls. The fixture contains only conspicuously synthetic values used to prove that field contents and query parameters never enter the compiler payload or artifact.

The same fixture accepts the test-only `large=1` query to create more than 100 KB of deterministic locator candidates. E2E verifies a compact POST response, separate GET loading, idempotent reuse, concurrent-call refusal, lifecycle recovery after an actual Studio process restart, and human-confirmed Draft restoration. The Studio renders only a bounded artifact summary and candidate counts, never the complete artifact.

To exercise the visible fixture journey, open Studio, keep `ncba-dpi-fixture`, check every synthetic attestation statement and the local marker, then use **Capture**, **Compile**, **Validate A/B**, **Approve**, **Promote**, **Run preflight**, and **Execute promoted A/B** in order.

## Non-negotiable safety boundary

- Training compilation requires explicit authorization, synthetic data, a locally verified marker, and complete fresh attestation.
- Clinical mode exposes no Compile control and its compilation endpoint returns `403`.
- The runtime imports no OpenAI SDK, requires no API key, and blocks OpenAI HTTP and WebSocket requests.
- No automated login, credential handling, cookie/token capture, network-response inspection, persistent clinical screenshot, CAPTCHA/MFA bypass, or real-patient action is supported.
- No actual DPI workflow has been selected or compiled. The first task must be chosen by the user and institution under [AUTHORIZED_USE.md](AUTHORIZED_USE.md).

## Status and limitations

Automated development and tests never contact the NCBA DPI. The operator has separately exercised the managed Training flow against an authorized synthetic record and produced a local GPT-5.6 Draft; this repository contains neither that capture nor browser state. The editability correction documented above has been validated only on local synthetic fixtures and has not been replayed automatically against the DPI. No real patient data or clinical workflow is used by the test suite. Institutional authorization remains mandatory.

This project is not RGPD certified, not HDS certified, and not a certified medical device. It is limited to authorized, administrative, reversible automation with human confirmation. It must not perform clinical decisions, prescribing, medical signatures, deletion, billing, or irreversible transactions.

See [SYNTHETIC_TO_CLINICAL.md](SYNTHETIC_TO_CLINICAL.md), [CLINICAL_RUNTIME.md](CLINICAL_RUNTIME.md), [SECURITY.md](SECURITY.md), and [THREAT_MODEL.md](THREAT_MODEL.md).

## License

MIT.
