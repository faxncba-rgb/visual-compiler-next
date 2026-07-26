# Application Profiles

`ApplicationProfileSchema` defines profile identity/version, separate training and runtime origins, allowed paths/actions, redaction and fingerprint versions, compatibility threshold, synthetic attestation and approval requirements, and the runtime OpenAI policy.

The `ncba-dpi` profile allows only `https://dpi-ncba.gbna-sante.fr`, requires synthetic attestation and human approval, limits compilation to a training profile, and forbids runtime OpenAI access. This declaration prepares a future authorized integration; it is not evidence of authorization or compatibility.

`ncba-dpi-fixture` is the sole test target. It explicitly permits local loopback only when the caller opts into the local-fixture exception. There is no silent switch for weakening URL controls.

Browser profiles are `ncba-dpi-training` and `ncba-dpi-clinical`. Both are visible and manually authenticated, but use independent out-of-repository state. Only training can compile. Clinical can execute promoted artifacts only and cannot create compiler page models.

Studio exposes exactly three managed selections:

- `ncba-dpi-fixture`: local synthetic fixture, training mode;
- `ncba-dpi-training`: configured NCBA origin, visible manual opening only, synthetic attestation required before capture or compilation;
- `ncba-dpi-clinical`: the same configured origin in an independent clinical context, execution only, capture and compilation technically forbidden.

Changing the selection updates labels and URL fields only. It performs no navigation or background request. The NCBA origin is opened only by the explicit **Open in managed browser** action and confirmation.

For `ncba-dpi-training`, allowlisting compares `new URL(target).origin` with the configured origin. HTTPS path and query changes on that exact origin are accepted, while sibling subdomains, HTTP, credential-bearing URLs, and forbidden schemes remain rejected.

After explicit opening, `AUTHENTICATION BOOTSTRAP` temporarily accepts HTTPS SSO redirects and popups without creating any capture or compiler input. The operator authenticates manually. Locking is refused until the primary page returns to the exact application origin. After the visible **Authentication complete — lock to application** action, `APPLICATION LOCKED` enforces that origin for primary-page navigation. Query strings remain memory-only and are removed before diagnostics, compiler input, artifacts, fingerprints, and audits.

Local Lab Mode may be enabled for `ncba-dpi-fixture` and
`ncba-dpi-training` only. In addition to the environment flag, Studio must bind
to loopback and the operator must make the single synthetic-record confirmation
for the current in-memory session. `ncba-dpi-clinical` rejects confirmation,
capture, compile, and Lab-run requests. The Lab shortcut changes workflow
friction only: it does not weaken origin locking, URL canonicalization,
redaction, cross-origin-frame exclusion, or OpenAI blocking.
