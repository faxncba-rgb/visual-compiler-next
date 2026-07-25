# Codex Collaboration

## Post-hackathon continuation — 2026-07-22

Codex created a separate repository while preserving Build Week history. It must never push to `upstream-build-week`, read external browser-profile state, request credentials, contact the NCBA DPI, or run live OpenAI compilation without a new explicit authorization.

All development and CI use `ncba-dpi-fixture`. The repository records only redacted structures and synthetic test markers. The compatibility probe is code-only and disabled. Before publishing, Codex runs the full test suite, probable-secret scan, tracked-file review, and remote verification.

The 2026-07-23 validation completed with build success, 36/36 tests, the focused 8/8 security suite, a clean scan of 75 repository files, and 8/8 E2E tests. E2E uses isolated loopback ports and never contacts the declared NCBA origin.

For the 2026-07-24 managed-profile milestone, Codex presents implementation and test results before publication, then commits and pushes only after the user's explicit instruction. Automated coverage may select the NCBA profile in Studio but must assert that no request reaches its domain; it must never click the external managed-browser action.

For the 2026-07-25 SSO milestone, automated and visual validation uses only a loopback application plus a separate loopback identity-provider fixture. `USE_LIVE_OPENAI=false` is enforced for Playwright Studio, so the live compiler branch is unreachable even if a developer has a local ignored environment file. The real NCBA origin is not opened, authentication data is not observed, and only canonical origins/pathnames may appear in diagnostics or artifacts.

For the semantic-locator recovery milestone, Codex must use only the local CGI fixture and the explicit offline mock instruction. No real captured payload may enter tests, logs, screenshots, documentation, or commits. Live OpenAI compilation remains disabled. A real Training retry requires a later explicit authorization after the local fixture validation is complete.

For compile recovery work, the existing 128 KB GPT artifact is immutable and
must remain local and untracked. Codex may inspect only bounded metadata and
privacy-scan results, must not print the complete artifact, and must exercise
recovery exclusively with the local large CGI fixture and `USE_LIVE_OPENAI=false`.

For locked Training execution work, Codex must validate only the loopback CGI
and synthetic SSO fixtures. It may add runtime support for an existing
Playwright `Page`, but must not open the real DPI, execute the recovered real
workflow, call OpenAI, export browser state, or include dynamic URLs and page
values in telemetry. A successful Training test may validate a Draft only;
approval and promotion remain distinct human decisions.

## Components Codex Designed

- Monorepo structure separating compile-time and runtime packages.
- Controlled demo site with layout variants A and B.
- Semantic IR schemas and runtime telemetry schemas.
- Deterministic locator engine and spatial utilities.
- Playwright runtime with no OpenAI SDK dependency.
- Responsive Studio UI and mobile interaction model.
- Private/public demo URL boundary for VPS operation.
- Persistent artifact storage and service health model.
- Pinned production container and Traefik deployment topology.

## Components Codex Implemented

- Demo website and phone-width table interaction.
- Page model extraction.
- GPT-5.6 compile-time interpreter interface with strict JSON validation.
- Responses API Structured Outputs integration with an API-compatible Zod
  schema, response-model diagnostics, and token accounting.
- Mock interpreter for offline tests.
- Locator ranking, duplicate-anchor handling, and candidate diagnostics.
- Generated Playwright source.
- Runtime replay with assertions, blocked OpenAI traffic, and zero-LLM
  telemetry.
- Atomic compiled-workflow writes and configurable persistent storage.
- Studio/demo health endpoints.
- Automatic Studio loading of the saved GPT-5.6 artifact for no-cost local
  inspection and replay.
- Local visible replay in a separate Chromium window with slow motion,
  final-state hold, and DOM-backed final-state evidence in telemetry.
- Append-only instruction-derived artifact identities, artifact registry API,
  and Studio workflow selection.
- Workflow-derived final-state verification and Playwright select execution.
- Production Dockerfile and Compose template.
- Deployment, verification, update, backup, and rollback documentation.
- Unit, integration, deployment-configuration, mobile, and runtime E2E tests.

## Human Decisions That Shaped the Product

- Separation of compile-time and runtime.
- Prohibition of LLM calls during execution.
- Controlled demo scope.
- Preference for explainability over broad autonomy.
- Selection of locator ranking rules.
- Decision to reject low-confidence compilation.
- Requirement to prepare but not execute the Hostinger VPS deployment.
- Requirement to keep secrets out of the repository and browser client.

## Limitations Identified by Codex

- OCR and image-template fallback interfaces exist in the IR, but the MVP does
  not execute them.
- Arbitrary public sites are explicitly out of scope.
- Live compilation depends on a valid OpenAI API key and model access.
- Mobile E2E uses Chromium with an iPhone Safari viewport/user agent; physical
  Safari verification remains a deployment-stage check.
- Docker is unavailable in this workspace, so the image and resolved Compose
  model must be validated on a Docker-capable host before deployment.

## Bugs Found and Fixed with Codex

- Replaced a TypeScript-loader-transformed `page.evaluate` function that failed
  in the browser with a browser-native evaluator.
- Made locator compilation skip unrelated duplicate text anchors.
- Prevented E2E tests from mutating the tracked workflow artifact.
- Corrected the production dependency classification needed by container start
  scripts.
- Removed the desktop-only three-column/mobile-overflow behavior from Studio.
- Added client-visible request errors and disabled controls during compile/run.
- Replaced optional Structured Outputs fields with required nullable fields and
  added a recursive strict-schema regression test.
- Replaced invisible headless Studio replay with explicit headful local replay
  while preserving headless defaults for APIs and automated tests.
- Replaced the single overwrite-prone output path with exclusive versioned
  artifact publication and explicit Studio selection.
- Restricted the offline interpreter to its documented fixture instead of
  silently accepting unrelated instructions.

## Testing Generated or Improved with Codex

- Semantic IR validation.
- Spatial relation calculations.
- Locator ranking, duplicate-anchor selection, and disabled-target exclusion.
- Runtime import/dependency/network safeguards.
- Runtime no-API-key path.
- Layout variant replay with zero OpenAI calls.
- iPhone-sized Studio layout, touch target, iframe, and storage-health checks.
- Deployment pin, internal/public URL, persistent-volume, and no-host-port
  assertions.
- Strict OpenAI response-schema compatibility.
- Real GPT-5.6 artifact generation with response-model and token diagnostics.
- Replay of that generated workflow on layout variants A and B with zero runtime
  LLM and OpenAI network calls.
- Dedicated E2E coverage that loads the tracked GPT-5.6 artifact directly rather
  than regenerating it with the offline interpreter.
- Automated assertions that the intended checkbox is checked and the
  confirmation result is visible after replay.
- Tests for two distinct instruction artifacts, immutable reference SHA,
  removal of replay target specialization, strict mock rejection, and select
  execution.

## GPT-5.6 Contribution at Compile Time

GPT-5.6 interprets the natural-language instruction and page model into validated
JSON semantic steps when live compilation is explicitly enabled. The runtime
never imports or calls GPT-5.6. The local milestone produced the tracked workflow
with one `gpt-5.6` compile request served by `gpt-5.6-sol`, followed by successful
zero-OpenAI replay on both controlled layouts.

## Milestone Handoff

The `codex/vps-mobile-deployment` branch contains the deployment/mobile milestone
plus a validated local GPT-5.6 compile-and-replay milestone. It has not been
pushed or deployed. Docker/VPS files are retained as an unvalidated option; the
active handoff is the local macOS demo with selectable versioned artifacts and
an optional, separately authorized GitHub pull request.

## Feedback

/feedback Codex Session ID: placeholder
