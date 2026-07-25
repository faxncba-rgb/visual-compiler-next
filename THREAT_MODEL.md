# Threat model

Protected assets include credentials, browser sessions, patient or business values, clinical page content, promoted workflows, and audit integrity. Threats include accidental operator error, malicious page content, compromised dependencies, unsafe redirects, artifact tampering, and over-broad automation.

Primary controls are strict origin/path allowlists, HTTPS by default, private-address denial, credential-in-URL denial, redirect validation, manual independent authentication, synthetic attestation, local marker verification, mandatory redaction, immutable versioned artifacts, SHA-256 verification, lifecycle gates, structural compatibility checks, unique targets, human confirmation, emergency stop, OpenAI network blocking, and redacted audit.

SSO redirect compatibility uses a deliberately narrow exception to strict application-origin navigation. In `AUTHENTICATION BOOTSTRAP`, cross-origin HTTPS navigation and popups are allowed but capture, compilation, URL persistence, and session observation are denied. An explicit human action can enter `APPLICATION LOCKED` only after the primary page returns to the configured origin. The locked phase applies strict origin policy to primary navigation and excludes cross-origin frames from capture.

The MVP does not claim protection against a compromised host, browser zero-day, DNS rebinding after validation, or a malicious authorized administrator. DNS/IP pinning, OS keychain signing, Ed25519 artifact signatures, sandboxed runtime processes, and formal privacy review remain future hardening.
