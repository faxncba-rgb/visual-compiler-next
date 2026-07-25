# Progress

## 2026-07-25 — Privacy-preserving semantic locator recovery

- Confirmed that the previous compiler payload removed the accessible names and labels required by the locator engine, leaving external controls without candidates when no fixture-only stable label existed.
- Added a classified semantic payload retaining bounded interface labels/control names/structural headings, accessibility sources, control state, geometry, and DOM/visual relations while excluding form values, hidden fields, URL parameters, storage, cookies, headers, and network data.
- Studio now displays the exact redacted compiler payload and requires an explicit SHA-bound human confirmation before Training compilation.
- Locator generation now ranks role/name, label, placeholder/type, control text, DOM relation, spatial relation, role ordinal, and deterministic control-type fallback candidates. Per-step counts and redacted zero-candidate explanations are visible.
- Added `/cgi-professional`, a wholly synthetic local fixture with multiple textareas and duplicate Save buttons but no `data-vc-stable-label`.
- The documented French fill-then-save instruction compiles with the offline mock and replays on the fixture with `llmCalls: 0` and `openAIRequests: 0`.
- Final validation: build passed; 45/45 unit and integration tests passed; 8/8 focused security tests plus a 78-file secret/import scan passed; and 12/12 Playwright E2E tests passed with one worker.
- Visual Studio verification confirmed that Compile remains disabled before payload approval, the preview excludes both synthetic form values and all query parameters, and confirmed compilation produces 8 candidates for the labelled textarea and 10 for the duplicate Save-button step.
- No DPI request, real capture content, patient data, or OpenAI call was used during implementation or tests.

## 2026-07-25 — Manual SSO bootstrap and application lock

- Added visible `AUTHENTICATION IN PROGRESS — capture and compilation disabled` and `APPLICATION LOCKED` states to Studio.
- Added the explicit **Authentication complete — lock to application** action, accepted only when the primary page has returned to the configured application origin.
- Managed Training now uses an ephemeral, memory-only Playwright context. HTTPS authentication redirects, popups, iframes, and subresources are allowed during bootstrap; unsafe schemes and OpenAI domains remain blocked.
- After locking, strict origin policy applies to primary-page navigation. Cross-origin iframes may render but are excluded from capture.
- Added a local two-origin SSO fixture and E2E coverage for redirect, popup, premature capture/compile refusal, wrong-origin lock refusal, successful return/lock, redacted compilation, post-lock escape blocking, and zero OpenAI calls.
- Final validation: `npm ci`, build, 42/42 unit and integration tests, 8/8 focused security tests plus a 76-file scan, and 11/11 Playwright E2E tests.
- Visual loopback verification completed through popup SSO, application lock, redacted capture, and offline mock compilation; the resulting visible artifact contained the canonical callback path and no query parameter or token.
- No NCBA domain, patient data, credential, or OpenAI service was contacted. The real DPI remains untested.

## 2026-07-25 — Dynamic training URLs with canonical privacy boundary

- NCBA training target validation now compares the exact HTTPS origin and accepts dynamic paths and query parameters on that origin.
- Studio validates the target locally, displays the canonical URL, and enables managed-browser opening only after complete synthetic attestation.
- Full target URLs remain memory-only; compiler inputs, workflow artifacts, fingerprints, and audits contain only `origin + pathname`.
- Managed Playwright navigation blocks redirects to any other origin while retaining runtime OpenAI blocking.
- Tests use fictitious parameter values and local fixtures only; no NCBA or OpenAI request is performed.
- Validation: clean install, build, 41/41 unit and integration tests, 8/8 focused security tests with a 75-file scan, and 10/10 Playwright E2E tests.

## 2026-07-24 — Visible managed application profiles

- Added Studio selection and active-mode display for `ncba-dpi-fixture`, `ncba-dpi-training`, and `ncba-dpi-clinical`.
- Selecting a profile updates local UI state only; external opening requires the explicit managed-browser button and confirmation.
- Compilation now requires a complete fresh synthetic-environment attestation before any page-model extraction.
- Clinical compilation and compiler capture are rejected technically.
- Managed training compilation reuses only an already-open manual page and sends only the existing redacted compiler model.
- The local fixture now exposes the complete visible journey: capture, mock compilation, validation on A/B, human approval, promotion, structural preflight, promoted execution on A/B, and revocation.
- Studio displays the redaction report, structural SHA-256, planned actions, preflight result, and `Runtime LLM calls: 0` / `OpenAI requests: 0`.
- Automated tests remain fixture-only. The NCBA domain was not contacted and no OpenAI call was made.
- Validation before publication: build, 38/38 tests, 8/8 focused security tests, a 75-file secret/import scan, and 10/10 Playwright E2E tests pass. Final clean-install, formatting, diff, secret, and browser checks are recorded before commit.

## 2026-07-22 — Post-hackathon synthetic-to-clinical foundation

- Created `visual-compiler-next` from the immutable Build Week history on branch `post-hackathon/synthetic-to-clinical`.
- Configured `upstream-build-week` with push disabled and the new GitHub repository as `origin`.
- Implemented Application Profiles, strict URL validation, synthetic attestation, redaction, structural fingerprints, lifecycle/hash, clinical preflight, redacted audit, and ephemeral parameters.
- Added distinct Training and Clinical Studio surfaces and backend `403` refusal for clinical compilation.
- Added `ncba-dpi-fixture` variants A/B plus unit, integration, security, and E2E coverage.
- Compatibility probe contract is disabled and was not executed. The real DPI was not contacted. No patient data, credential, clinical workflow, or OpenAI call was used.
- Final validation on 2026-07-23: `npm ci`, `npm run build`, 36/36 tests, 8/8 focused security tests plus the 75-file secret/import scan, and 8/8 Playwright E2E tests passed.
- Matching Playwright Chromium 1.61.1 was already installed locally. A redundant download attempt was stopped after the restricted network produced no progress; the existing matching browser completed E2E successfully.

## Completed Milestones

- Milestone 0: repository setup, lint/format baseline, TypeScript config, test
  config, and basic docs.
- Milestone 1: controlled demo site with variants A and B.
- Milestone 3: Semantic IR schemas and validation tests.
- Milestone 5: spatial utilities and locator ranking tests.
- Milestone 7: deterministic runtime package with no OpenAI dependency safeguard
  tests.
- Milestone 9: end-to-end compilation and deterministic browser replay across
  layout variants A and B.
- Milestone 10: responsive mobile Studio, persistent workflow storage, health
  checks, pinned Playwright production image, and Traefik-compatible Hostinger
  VPS deployment template.
- Milestone 11: real local GPT-5.6 Structured Outputs compilation and
  deterministic replay of the generated workflow across variants A and B.
- Milestone 12: append-only versioned workflow artifacts, Studio artifact
  selection, workflow-derived replay checks, strict offline fixture behavior,
  and implemented select execution.

## Current State

- Branch: `codex/vps-mobile-deployment`.
- Studio uses a single-column, safe-area-aware layout at phone widths with
  44-pixel touch controls and a scrollable demo preview/details view.
- Studio loads the saved workflow artifact and compile diagnostics on startup,
  so the local Safari demo can inspect and replay the GPT-5.6 result without
  triggering another compile request.
- Studio lists all valid workflow artifacts and executes the selected id.
  Successful compilation creates a new instruction-derived id/name with an
  eight-character suffix and cannot replace an existing file.
- Studio Run A/B opens a separate headful Chromium replay with 500 ms slow
  motion and a four-second final-state hold. The embedded iframe remains an
  independent preview because it cannot share Playwright's browser context.
- `DEMO_SITE_INTERNAL_URL` is used by server-side Playwright;
  `DEMO_SITE_PUBLIC_URL` is used by the iframe.
- Compiled workflows are published atomically with an exclusive no-overwrite
  operation in `WORKFLOW_STORAGE_DIR`; the production template mounts a named
  volume there.
- Studio and demo expose JSON health endpoints; Studio health verifies that
  workflow storage is readable and writable.
- Playwright and the production Microsoft Playwright image are pinned to
  `1.61.1`; the image includes matching Chromium and Linux dependencies.
- The runtime package still has no OpenAI dependency, blocks service workers and
  OpenAI browser requests, and only succeeds with zero model/OpenAI calls.
- The Compose template publishes no host ports, requires an existing Traefik
  access-control middleware for Studio, and passes `OPENAI_API_KEY` only to the
  server-side Studio container.
- The compiler now uses the Responses API Structured Outputs helper with a
  strict Zod schema compatible with OpenAI's required-field rules, requests
  `gpt-5.6` at medium reasoning effort, disables response storage, and records
  the response model and token usage in diagnostics.
- Local development commands load `.env` automatically. The current local file
  is ignored by Git, has mode `0600`, and contains the expected live-compile
  settings without exposing the credential to browser code or runtime.
- The tracked `pending-review.workflow.json` artifact was generated by a real
  `gpt-5.6` request served by `gpt-5.6-sol`. It records the response model and
  token usage and contains no credential.
- No VPS deployment or GitHub push has been performed.

## Bugs Found and Fixed

- Browser page-model capture failed under the TypeScript runtime because a
  generated `__name` helper was serialized into `page.evaluate`; capture now
  runs as browser-native JavaScript.
- Repeated `Pending review` labels could make compilation choose an unrelated
  anchor with no spatial candidates; anchor selection now skips duplicates that
  do not produce a valid related target.
- E2E compilation overwrote the tracked precompiled artifact; tests now write to
  an isolated test output path.
- The production-only install would have omitted `tsx`; it is now a production
  dependency and the npm lockfile records that classification.
- The original interpreter schema used optional object properties, which strict
  Structured Outputs rejects; the API-facing schema now uses required nullable
  fields and strips null object fields before application validation.
- Studio previously ran Playwright headless, so successful actions were invisible
  in the separate iframe. Interactive runs now request a visible browser while
  API and automated test runs remain headless by default.
- Studio compilation previously targeted the single validated artifact path.
  Compilation now creates versioned files, while listing/loading/running uses an
  explicitly validated artifact id.
- Visible replay previously asserted one Insurance document checkbox in server
  code. Runtime final-state evidence is now derived from state-changing actions,
  locators, and postconditions in the selected workflow.
- The schema advertised `select` while runtime rejected it. Runtime now executes
  Playwright `selectOption` and verifies the resulting value.
- The offline mock previously ignored alternate instructions. It now accepts
  only the normalized documented fixture and rejects every other instruction.

## Verification Status

- Dependency install: `npm ci` passed with npm 11.10.0 bootstrapped through the
  bundled Node environment; audit reported zero vulnerabilities.
- `npm run build`: passing.
- `npm test`: 17 tests passing.
- Matching Playwright Chromium 1228 for Playwright `1.61.1`: installed.
- `npm run test:e2e`: five tests passing with OpenAI variables removed,
  including isolated compile/replay, direct replay of the tracked GPT-5.6
  artifact on variants A/B, two-instruction versioned artifact generation,
  select execution, and an iPhone-sized Safari-user-agent Studio check.
- Strict Structured Outputs schema test: passing and verifies that all generated
  object schemas forbid additional properties and require every property.
- Real local GPT-5.6 compilation: passing with one compile-time model call,
  response model `gpt-5.6-sol`, 5,609 input tokens, 733 output tokens, 176
  reasoning tokens, and 6,342 total tokens.
- The generated two-step workflow selected unique accessibility locators at
  0.96 confidence. Deterministic replay passed on variants A and B with
  `llmCalls: 0`, `openAIRequests: 0`, and every step passing.
- Visible replay on macOS variants A and B: passing. Step durations were
  approximately 500 ms, final state remained open for four seconds, and
  telemetry verified the Insurance document checkbox was checked and
  `Compiled workflow completed` was visible.
- Automated final-state verification: passing in headless E2E for both the
  tracked GPT-5.6 artifact and Studio's `/api/run` path.
- Secret audit after artifact generation: passing; `.env` remains ignored and no
  API key appears in tracked or untracked project files.
- Validated artifact immutability: SHA-256 remains
  `c08d5ce63b6ef07ca9947d01b4ed3744aafea94f942279919df0efcd9fed6d63`
  before and after build, unit/integration tests, and E2E.
- Compose YAML parse: passing.
- Docker image build and `docker compose config`: not run because Docker is not
  installed in this workspace environment.

## Remaining External Verification

- Docker image, Compose, physical iPhone, and VPS validation are retained only
  as unvalidated future options and are not part of the current macOS milestone.

## Next Actions Requiring User Direction

- Push the branch and create the pull request only after explicit approval is
  reconfirmed. Do not merge it yet.
