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

The Studio is a first professional MVP: the security primitives and promoted-only runtime entry point are implemented and tested, while persisted approval/promotion orchestration and authorized clinical browser integration remain future milestones. Ed25519 signing is deferred; promoted artifacts use verified SHA-256.

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
