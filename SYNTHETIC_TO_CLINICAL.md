# Synthetic-to-clinical lifecycle

1. Select an Application Profile and authorized synthetic environment.
2. Open the ephemeral managed Training browser after complete synthetic attestation.
3. Authenticate manually during `AUTHENTICATION BOOTSTRAP`; capture and compilation remain disabled.
4. Return the primary page to the configured application origin and explicitly choose **Authentication complete — lock to application**.
5. Capture only after Studio reports `APPLICATION LOCKED`; cross-origin frames are excluded.
6. Verify an institution-approved synthetic marker locally.
7. Explicitly check every attestation statement; it expires after 15 minutes by default.
8. Build and redact a page model before any compiler boundary.
9. Compile to Semantic IR and a new versioned deterministic artifact.
10. Validate against local synthetic variants.
11. Record human approval, then promote only if validation passed.
12. In the independent clinical profile, verify hash, profile, origin/path, promotion state, OpenAI prohibition, structural compatibility, required elements, preconditions, and target uniqueness.
13. Display planned actions and require confirmation; allow cancellation and emergency stop.
14. Execute locally with zero model calls and write only a redacted audit.

No actual NCBA workflow is selected in this MVP. The next product decision belongs to the user and authorized institution.
