# Synthetic-to-clinical lifecycle

1. Select an Application Profile and authorized synthetic environment.
2. Manually authenticate using the isolated training browser profile.
3. Verify an institution-approved synthetic marker locally.
4. Explicitly check every attestation statement; it expires after 15 minutes by default.
5. Build and redact a page model before any compiler boundary.
6. Compile to Semantic IR and a new versioned deterministic artifact.
7. Validate against local synthetic variants.
8. Record human approval, then promote only if validation passed.
9. In the independent clinical profile, verify hash, profile, origin/path, promotion state, OpenAI prohibition, structural compatibility, required elements, preconditions, and target uniqueness.
10. Display planned actions and require confirmation; allow cancellation and emergency stop.
11. Execute locally with zero model calls and write only a redacted audit.

No actual NCBA workflow is selected in this MVP. The next product decision belongs to the user and authorized institution.
