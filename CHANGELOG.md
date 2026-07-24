# Changelog

## Unreleased

- Added visible fixture, NCBA training, and NCBA clinical profile selection in Studio.
- Added explicit managed-browser opening with isolated local state and no automatic navigation.
- Enforced fresh synthetic-data attestation before capture or compilation and technical clinical compilation/capture denial.
- Added the visible fixture lifecycle journey from redacted capture through promoted A/B execution, including redaction, fingerprint, preflight, and zero-call telemetry panels.
- Added fixture-only tests proving profile selection makes no NCBA request.

## 0.2.0 — 2026-07-22

- Started the post-hackathon repository while preserving Build Week history.
- Added synthetic-to-clinical Application Profiles, browser-mode separation, attestation, redaction, fingerprints, workflow lifecycle, preflight, redacted audit, and ephemeral runtime parameters.
- Added the synthetic NCBA technical fixture with layouts A/B.
- Added security tests and fixture-only GitHub Actions CI.
- Documented that no real DPI, patient data, clinical workflow, or OpenAI call was used.
