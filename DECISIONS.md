# Decisions

## 2026-07-25 — Classified semantic text instead of text-free compiler models

The compiler boundary retains only bounded interface text that identifies interactive controls: computed accessible names, associated labels, ARIA label sources, generic placeholders, control text, and nearby structural headings. Form values, hidden fields, arbitrary page content, query parameters, browser state, and network material remain excluded. Retained text is explicitly classified and must be reviewed in Studio before compilation. This is the minimum reliable alternative to depending on fixture-only test attributes.

Locator selection uses a deterministic ranked cascade and records per-step candidate counts. DOM-container and spatial relationships disambiguate repeated control names. Absolute coordinates remain unacceptable as the only strategy.

## 2026-07-22 — Post-hackathon safety boundary

- Preserve Build Week Git history in a new repository and disable pushes to `upstream-build-week`.
- Treat identical training and clinical origins as insufficient evidence of mode; require isolated browser state and explicit mode.
- Use SHA-256 for the first promoted-artifact MVP; defer Ed25519 until key management is reliable.
- Keep the NCBA compatibility probe disabled and never contact the real target during development or CI.
- Require a local synthetic marker plus complete expiring attestation before NCBA compilation.

## ADR-001: Separate Compile Time From Runtime

Date: 2026-07-18

Status: Accepted

Visual Compiler uses GPT-5.6 only during compilation. The generated workflow is a validated artifact that the Playwright runtime can execute later with `OPENAI_API_KEY` unset. This is the central product proof: intelligence is paid for once, execution is deterministic and auditable.

## ADR-002: Controlled Vertical Slice

Date: 2026-07-18

Status: Accepted

The MVP targets a local demo page with two layout variants. This preserves enough complexity to prove spatial reasoning while keeping judge setup reliable.

## ADR-003: Separate Internal and Public Demo URLs

Date: 2026-07-19

Status: Accepted

Server-side Playwright uses `DEMO_SITE_INTERNAL_URL` on the private Compose
network. The iframe uses `DEMO_SITE_PUBLIC_URL` through Traefik and HTTPS. This
avoids asking a remote iPhone to resolve a Docker service name while keeping
browser automation off the public ingress path.

## ADR-004: Persist Artifacts, Keep Runtime Model-Free

Date: 2026-07-19

Status: Accepted

Compiled workflows are written atomically to a configurable directory backed by
a named Docker volume. Runtime retains no OpenAI package dependency, rejects
attempted OpenAI browser traffic, and returns successful telemetry only when
both model and OpenAI request counts are zero.

## ADR-005: Version Compilations Instead of Replacing Artifacts

Date: 2026-07-19

Status: Accepted

Each successful compilation creates a new artifact with an
instruction-derived slug and a short random suffix. Final publication uses an
exclusive filesystem operation, so an existing artifact cannot be replaced even
if an id collision occurs. Studio lists and executes the explicitly selected
artifact. The validated GPT-5.6 reference artifact remains immutable.

## ADR-006: Compact Compile Acknowledgements and Persistent Idempotency

Date: 2026-07-25

Status: Accepted

`POST /api/compile` never returns the complete workflow. It returns a bounded
acknowledgement and Studio retrieves the immutable artifact through
`GET /api/workflow`. A SHA-256 idempotency key covers the normalized
instruction, Training profile, canonical origin/path, and reviewed compiler
payload hash. Restricted local sidecars persist lifecycle state, artifact hash,
fingerprint and idempotency mapping without session or medical data. A
compatible existing artifact is restored as Draft only after a fresh capture,
unique-locator verification, and explicit human confirmation.
