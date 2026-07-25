import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendRedactedAudit,
  clinicalPreflight,
  computeWorkflowHash,
  createRedactedAudit,
  createStructuralFingerprint,
  localFixtureProfile,
  redactPageModel,
  transitionWorkflow,
  verifyWorkflowHash,
  withRuntimeParameters,
  type PromotedWorkflow,
} from "@visual-compiler/clinical-safety";

const fingerprint = createStructuralFingerprint(
  redactPageModel({
    url: "http://127.0.0.1:4173/ncba-fixture",
    nodes: [
      { tagName: "button", role: "button", label: "Open", required: true },
    ],
  }),
);
const unsigned: Omit<PromotedWorkflow, "workflowSha256"> = {
  workflowId: "fixture-open-001",
  workflowVersion: "1.0.0",
  applicationProfileId: "ncba-dpi-fixture",
  state: "Promoted",
  allowedRuntimeOrigins: ["http://127.0.0.1:4173"],
  allowedPaths: ["/ncba-fixture"],
  structuralFingerprint: fingerprint,
  fingerprintVersion: "1",
  compileModel: "gpt-5.6",
  promptVersion: "v1",
  compiledFromSyntheticData: true,
  syntheticAttestationTimestamp: new Date().toISOString(),
  selectedLocators: ["role=button[name=Open]"],
  fallbackLocators: [],
  preconditions: ["button unique"],
  postconditions: ["status visible"],
  confidence: 0.96,
  approvalTimestamp: new Date().toISOString(),
  promotionTimestamp: new Date().toISOString(),
  runtimeOpenAIPolicy: "forbidden",
};
const promoted: PromotedWorkflow = {
  ...unsigned,
  workflowSha256: computeWorkflowHash(unsigned),
};

describe("workflow lifecycle and clinical preflight", () => {
  it("allows only the explicit lifecycle", () => {
    expect(transitionWorkflow("Draft", "Validated")).toBe("Validated");
    expect(transitionWorkflow("Validated", "Approved")).toBe("Approved");
    expect(transitionWorkflow("Approved", "Promoted")).toBe("Promoted");
    expect(transitionWorkflow("Promoted", "Revoked")).toBe("Revoked");
    expect(() => transitionWorkflow("Draft", "Promoted")).toThrow();
    expect(() => transitionWorkflow("Approved", "Promoted", false)).toThrow();
  });

  it("verifies hashes and rejects alteration", () => {
    expect(verifyWorkflowHash(promoted)).toBe(true);
    expect(verifyWorkflowHash({ ...promoted, confidence: 0.1 })).toBe(false);
  });

  it("fails closed for non-promoted, unknown-origin, ambiguous, or unconfirmed runs", () => {
    const ok = clinicalPreflight({
      workflow: promoted,
      profile: localFixtureProfile,
      url: "http://127.0.0.1:4173/ncba-fixture",
      actualFingerprint: fingerprint,
      targetsUnique: true,
      preconditionsPassed: true,
      humanConfirmed: true,
    });
    expect(ok.allowed).toBe(true);
    expect(
      clinicalPreflight({
        workflow: { ...promoted, state: "Validated" },
        profile: localFixtureProfile,
        url: "http://127.0.0.1:4173/ncba-fixture",
        actualFingerprint: fingerprint,
        targetsUnique: false,
        preconditionsPassed: true,
        humanConfirmed: false,
      }).allowed,
    ).toBe(false);
    expect(
      clinicalPreflight({
        workflow: promoted,
        profile: localFixtureProfile,
        url: "https://example.com/",
        actualFingerprint: fingerprint,
        targetsUnique: true,
        preconditionsPassed: true,
        humanConfirmed: true,
      }).allowed,
    ).toBe(false);
  });

  it("redacts audit errors and clears runtime parameters", async () => {
    const parameters = { patientReference: "SYNTHETIC-ONLY" };
    await withRuntimeParameters(parameters, async (memory) =>
      expect(memory.patientReference).toBe("SYNTHETIC-ONLY"),
    );
    expect(parameters).toEqual({});
    const audit = createRedactedAudit({
      workflow: promoted,
      origin: "http://127.0.0.1:4173/ncba-fixture?patient_id=FAKE-A&mytime=111",
      structuralCompatibility: 1,
      startTime: "2026-07-22T10:00:00.000Z",
      endTime: "2026-07-22T10:00:01.000Z",
      stepIds: ["s1"],
      actionTypes: ["click"],
      stepResults: ["passed"],
      errors: [new Error("PRIVATE")],
    });
    expect(JSON.stringify(audit)).not.toContain("PRIVATE");
    expect(JSON.stringify(audit)).not.toContain("patient_id");
    expect(JSON.stringify(audit)).not.toContain("mytime");
    expect(JSON.stringify(audit)).not.toContain("FAKE-A");
    expect(audit).toMatchObject({
      origin: "http://127.0.0.1:4173",
      targetUrl: "http://127.0.0.1:4173/ncba-fixture",
      llmCalls: 0,
      openAIRequests: 0,
    });
    const directory = await mkdtemp(path.join(tmpdir(), "vc-audit-"));
    const auditPath = path.join(directory, "audit.ndjson");
    try {
      await appendRedactedAudit(auditPath, audit);
      const stored = await readFile(auditPath, "utf8");
      expect(stored).not.toContain("PRIVATE");
      expect(JSON.parse(stored)).toMatchObject({
        workflowId: promoted.workflowId,
        llmCalls: 0,
        openAIRequests: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
