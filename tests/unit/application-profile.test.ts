import { describe, expect, it } from "vitest";
import {
  ApplicationProfileSchema,
  browserProfiles,
  createStudioApplicationProfiles,
  localFixtureProfile,
  ncbaDpiProfile,
  requireValidAttestation,
  resolveStudioProfileTarget,
  syntheticAttestationStatements,
  validateRedirect,
  validateTargetUrl,
} from "@visual-compiler/clinical-safety";
import { canonicalizeTargetUrl } from "@visual-compiler/shared";

const completeAttestation = (attestedAt = new Date().toISOString()) => ({
  profileId: "ncba-dpi",
  statements: Object.fromEntries(
    syntheticAttestationStatements.map((key) => [key, true]),
  ),
  syntheticIndicator: "training-banner",
  indicatorVerifiedLocally: true,
  attestedAt,
});

describe("Application Profiles and safe URL mode", () => {
  it("validates the NCBA profile and separates browser modes", () => {
    expect(
      ApplicationProfileSchema.parse(ncbaDpiProfile).runtimeOpenAIPolicy,
    ).toBe("forbidden");
    expect(ncbaDpiProfile.compilation).toBe("training profile only");
    expect(browserProfiles.training.id).not.toBe(browserProfiles.clinical.id);
    expect(browserProfiles.training.compilationAllowed).toBe(true);
    expect(browserProfiles.clinical.compilationAllowed).toBe(false);
  });

  it("exposes the three managed Studio profiles without weakening origins", () => {
    const profiles = createStudioApplicationProfiles("http://127.0.0.1:4273");
    expect(profiles.map((profile) => profile.id)).toEqual([
      "ncba-dpi-fixture",
      "ncba-dpi-training",
      "ncba-dpi-clinical",
    ]);
    expect(
      resolveStudioProfileTarget({
        profileId: "ncba-dpi-training",
        targetUrl: "https://dpi-ncba.gbna-sante.fr/",
        purpose: "open",
      }).profile.managedBrowserOnly,
    ).toBe(true);
    expect(() =>
      resolveStudioProfileTarget({
        profileId: "ncba-dpi-clinical",
        targetUrl: "https://dpi-ncba.gbna-sante.fr/",
        purpose: "compile",
      }),
    ).toThrow(/disabled in clinical/);
    expect(() =>
      resolveStudioProfileTarget({
        profileId: "ncba-dpi-clinical",
        targetUrl: "https://dpi-ncba.gbna-sante.fr/",
        purpose: "capture",
      }),
    ).toThrow(/capture is technically disabled/);
    expect(() =>
      resolveStudioProfileTarget({
        profileId: "ncba-dpi-fixture",
        targetUrl: "https://example.com/",
        purpose: "open",
        fixtureOrigin: "http://127.0.0.1:4273",
      }),
    ).toThrow(/origin/);
  });

  it("allows only configured origins and paths", () => {
    expect(
      validateTargetUrl("https://dpi-ncba.gbna-sante.fr/", {
        mode: "training",
        profile: ncbaDpiProfile,
      }).origin,
    ).toBe("https://dpi-ncba.gbna-sante.fr");
    expect(() =>
      validateTargetUrl("https://example.com/", {
        mode: "training",
        profile: ncbaDpiProfile,
      }),
    ).toThrow(/origin/);
    expect(
      validateTargetUrl("http://127.0.0.1:4173/ncba-fixture?variant=A", {
        mode: "training",
        profile: localFixtureProfile,
        allowExplicitLocalFixture: true,
      }).pathname,
    ).toBe("/ncba-fixture");
  });

  it("allows dynamic same-origin training paths while canonicalizing away parameters", () => {
    const targets = [
      "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi?patient_id=FAKE-A&mytime=111",
      "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi?patient_id=FAKE-B&mytime=222",
    ];
    const resolved = targets.map(
      (target) =>
        resolveStudioProfileTarget({
          profileId: "ncba-dpi-training",
          targetUrl: target,
          purpose: "open",
        }).url,
    );
    expect(resolved.map((url) => url.toString())).toEqual(targets);
    expect(resolved.map(canonicalizeTargetUrl)).toEqual([
      "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi",
      "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi",
    ]);
  });

  it("rejects insecure, sibling-subdomain, and cross-origin redirects", () => {
    expect(() =>
      validateTargetUrl(
        "http://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi",
        { mode: "training", profile: ncbaDpiProfile },
      ),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateTargetUrl(
        "https://other.dpi-ncba.gbna-sante.fr/saisie/consultations.cgi",
        { mode: "training", profile: ncbaDpiProfile },
      ),
    ).toThrow(/origin/);
    expect(() =>
      validateRedirect(
        new URL(
          "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi?patient_id=FAKE",
        ),
        "https://outside.invalid/redirect",
        { mode: "training", profile: ncbaDpiProfile },
      ),
    ).toThrow(/origin|Cross-origin/);
  });

  it.each([
    "file:///tmp/a",
    "data:text/plain,a",
    "javascript:alert(1)",
    "blob:https://dpi-ncba.gbna-sante.fr/fake",
    "chrome://settings",
  ])("rejects forbidden protocol %s", (target) => {
    expect(() =>
      validateTargetUrl(target, { mode: "training", profile: ncbaDpiProfile }),
    ).toThrow(/forbidden/);
  });

  it("rejects credentials, private targets, and forbidden redirects", () => {
    expect(() =>
      validateTargetUrl("https://user:pass@dpi-ncba.gbna-sante.fr/", {
        mode: "training",
        profile: ncbaDpiProfile,
      }),
    ).toThrow(/Credentials/);
    expect(() =>
      validateTargetUrl("http://127.0.0.1/", {
        mode: "training",
        profile: ncbaDpiProfile,
      }),
    ).toThrow();
    const source = new URL("https://dpi-ncba.gbna-sante.fr/");
    expect(() =>
      validateRedirect(source, "https://example.com/", {
        mode: "training",
        profile: ncbaDpiProfile,
      }),
    ).toThrow();
  });

  it("requires a complete, fresh synthetic attestation", () => {
    expect(
      requireValidAttestation(completeAttestation(), ncbaDpiProfile).profileId,
    ).toBe("ncba-dpi");
    expect(() =>
      requireValidAttestation(
        { ...completeAttestation(), statements: {} },
        ncbaDpiProfile,
      ),
    ).toThrow();
    expect(() =>
      requireValidAttestation(
        completeAttestation("2020-01-01T00:00:00.000Z"),
        ncbaDpiProfile,
      ),
    ).toThrow(/expired/);
  });
});
