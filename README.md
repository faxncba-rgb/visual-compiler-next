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

The compiler boundary receives structural fields and explicitly marked stable labels only. It does not receive cookies, authentication tokens, input or textarea values, contenteditable values, browser storage, headers, form payloads, or network responses.

The managed Training flow has two explicit phases. During **AUTHENTICATION BOOTSTRAP**, temporary HTTPS redirects, popups, iframe navigation, and subresources may cross origins so the user can authenticate manually. Capture and compilation stay technically disabled, OpenAI domains and unsafe schemes remain blocked, and Studio displays only the current origin. When the primary page returns to the exact configured application origin, the user must choose **Authentication complete — lock to application**. **APPLICATION LOCKED** then rejects main-page navigation away from that origin while allowing required HTTPS subresources and iframes; cross-origin frames are excluded from capture.

The NCBA training profile allows any HTTPS pathname and dynamic query string on the exact configured origin. The full URL exists only in memory for browser navigation. Before compiler input, persistence, fingerprinting, audit output, or diagnostics, it is canonicalized to `origin + pathname`; all query parameters and fragments are discarded. Authentication origins are never written to workflow artifacts.

On the local fixture, Studio visibly demonstrates the complete milestone: redacted capture, mock compilation, `Draft → Validated → Approved → Promoted`, structural preflight, and promoted execution on variants A and B. Redaction counts, the structural SHA-256, planned actions, preflight result, and zero-call runtime telemetry remain visible. `Revoked` is also exposed and immediately closes promoted execution.

The Studio is a first professional MVP: lifecycle orchestration is in memory for this milestone, while durable approval records and authorized clinical browser integration remain future work. Ed25519 signing is deferred; promoted artifacts use verified SHA-256.

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

To exercise the visible fixture journey, open Studio, keep `ncba-dpi-fixture`, check every synthetic attestation statement and the local marker, then use **Capture**, **Compile**, **Validate A/B**, **Approve**, **Promote**, **Run preflight**, and **Execute promoted A/B** in order.

## Non-negotiable safety boundary

- Training compilation requires explicit authorization, synthetic data, a locally verified marker, and complete fresh attestation.
- Clinical mode exposes no Compile control and its compilation endpoint returns `403`.
- The runtime imports no OpenAI SDK, requires no API key, and blocks OpenAI HTTP and WebSocket requests.
- No automated login, credential handling, cookie/token capture, network-response inspection, persistent clinical screenshot, CAPTCHA/MFA bypass, or real-patient action is supported.
- No actual DPI workflow has been selected or compiled. The first task must be chosen by the user and institution under [AUTHORIZED_USE.md](AUTHORIZED_USE.md).

## Status and limitations

The real NCBA DPI at `https://dpi-ncba.gbna-sante.fr/` has **not** been contacted or tested. No patient data has been used and no clinical workflow has been executed. Institutional authorization remains mandatory.

This project is not RGPD certified, not HDS certified, and not a certified medical device. It is limited to authorized, administrative, reversible automation with human confirmation. It must not perform clinical decisions, prescribing, medical signatures, deletion, billing, or irreversible transactions.

See [SYNTHETIC_TO_CLINICAL.md](SYNTHETIC_TO_CLINICAL.md), [CLINICAL_RUNTIME.md](CLINICAL_RUNTIME.md), [SECURITY.md](SECURITY.md), and [THREAT_MODEL.md](THREAT_MODEL.md).

## License

MIT.
