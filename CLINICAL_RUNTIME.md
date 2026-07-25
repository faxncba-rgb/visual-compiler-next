# Clinical runtime

Clinical runtime accepts promoted workflows only. A preflight failure executes zero actions. Checks cover profile, URL origin/path, SHA-256, state, OpenAI policy, structural fingerprint, compatibility threshold, required elements, preconditions, locator uniqueness, and human confirmation.

Runtime parameters are injected locally after compilation, masked from logs, retained in memory only for the operation, and explicitly cleared afterward. No real medical parameters are used by tests.

The expected operator display is `Workflow approved`, `Structural compatibility: …`, `Runtime LLM calls: 0`, and `OpenAI requests: 0`. The current MVP implements and tests the underlying preflight/audit structures; complete persisted approval and Stop orchestration is a subsequent milestone.

The optional compatibility probe is disabled by default, excluded from CI, and has never been run against the real DPI. A future authorized operator may launch it manually in a visible browser after confirmation. It must aggregate only DOM/control/iframe/Shadow DOM/canvas/SPA/stable-label counts and immediately discard temporary page data.

The **Test run on locked Training page** feature is intentionally separate from this clinical runtime. It accepts Draft workflows only, reuses the current synthetic Training session, and can mark a successful Draft as Validated. It cannot approve, promote, or execute a clinical workflow. Clinical execution continues to require a promoted artifact and the full clinical preflight.
