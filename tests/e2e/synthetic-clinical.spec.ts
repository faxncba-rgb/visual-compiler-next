import { expect, test } from "@playwright/test";
import {
  computeWorkflowHash,
  createStructuralFingerprint,
  localFixtureProfile,
  redactPageModel,
  type PromotedWorkflow,
} from "@visual-compiler/clinical-safety";
import { runPromotedWorkflowObject } from "@visual-compiler/runtime";
import { SemanticWorkflowSchema } from "@visual-compiler/semantic-ir";

test("synthetic fixture exposes training and clinical variants without contacting the DPI", async ({
  page,
}) => {
  await page.goto("/ncba-fixture?mode=training&variant=A");
  await expect(page.getByRole("status").first()).toContainText(
    "SYNTHETIC DATA ONLY",
  );
  await expect(
    page.getByRole("table", { name: "Synthetic administrative queue" }),
  ).toBeVisible();
  await expect(page.getByText("TEST-ADMIN-001", { exact: true })).toBeVisible();

  await page.goto("/ncba-fixture?mode=training&variant=B");
  await expect(page.getByText("layout B")).toBeVisible();

  await page.goto("/ncba-fixture?mode=clinical&variant=A");
  await expect(page.getByRole("status").first()).toContainText(
    "OPENAI ACCESS FORBIDDEN",
  );
});

test("Studio separates training from clinical runtime and rejects clinical compilation", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3100/");
  await expect(page.getByLabel("Training Compilation")).toContainText(
    "SYNTHETIC DATA ONLY",
  );
  const clinical = page.getByLabel("Clinical Runtime");
  await expect(clinical).toContainText("PROMOTED WORKFLOWS ONLY");
  await expect(clinical.getByRole("button", { name: "Compile" })).toHaveCount(
    0,
  );
  const response = await page.request.post(
    "http://127.0.0.1:3100/api/clinical/compile",
    { data: { instruction: "test" } },
  );
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining("disabled"),
  });
});

test("a promoted synthetic workflow executes on variants A and B with zero OpenAI calls", async () => {
  const profile = {
    ...localFixtureProfile,
    trainingOrigins: ["http://127.0.0.1:4273"],
    runtimeOrigins: ["http://127.0.0.1:4273"],
  };
  const fingerprint = createStructuralFingerprint(
    redactPageModel({
      url: "http://127.0.0.1:4273/ncba-fixture",
      nodes: [
        {
          tagName: "input",
          role: "checkbox",
          label: "administrative-row-selection",
          required: true,
        },
        {
          tagName: "button",
          role: "button",
          label: "reversible-administrative-action",
          required: true,
        },
      ],
    }),
  );
  const workflow = SemanticWorkflowSchema.parse({
    id: "synthetic-administrative-open",
    version: "1.0.0",
    name: "Synthetic reversible administrative action",
    source: {
      url: "http://127.0.0.1:4273/ncba-fixture",
      viewport: { width: 1100, height: 800 },
    },
    steps: [
      {
        id: "select-test-record",
        action: "check",
        intent: "Select the synthetic administrative record.",
        target: {
          role: "checkbox",
          accessibleName: "TEST-ADMIN-001 selected",
          relations: [],
        },
        preconditions: [],
        postconditions: [
          {
            type: "checkbox-state",
            target: "synthetic record selection",
            expected: true,
          },
        ],
        candidates: [],
        selectedLocator: {
          kind: "semantic-rule",
          primary: "role=checkbox[name='TEST-ADMIN-001 selected']",
          rule: {
            candidateRole: "checkbox",
            candidateText: "TEST-ADMIN-001 selected",
            relation: "nearest",
            ordinal: 1,
            enabledOnly: true,
            visibleOnly: true,
          },
          confidence: 1,
          explanation: "Synthetic accessible label.",
        },
      },
      {
        id: "stage-administrative-action",
        action: "click",
        intent: "Stage the reversible synthetic administrative action.",
        target: {
          role: "button",
          accessibleName: "Open TEST-ADMIN-001",
          relations: [],
        },
        preconditions: [],
        postconditions: [
          {
            type: "text-visible",
            target: "Synthetic administrative action staged",
            expected: "Synthetic administrative action staged",
          },
        ],
        candidates: [],
        selectedLocator: {
          kind: "semantic-rule",
          primary: "role=button[name='Open TEST-ADMIN-001']",
          rule: {
            candidateRole: "button",
            candidateText: "Open TEST-ADMIN-001",
            relation: "nearest",
            ordinal: 1,
            enabledOnly: true,
            visibleOnly: true,
          },
          confidence: 1,
          explanation: "Synthetic accessible label.",
        },
      },
    ],
    generatedPlaywright: "// deterministic synthetic fixture workflow",
    compiledAt: "2026-07-22T00:00:00.000Z",
    compileModel: "precompiled-sample",
    metadata: {
      compilerVersion: "0.2.0",
      targetUrl: "http://127.0.0.1:4273/ncba-fixture",
    },
    diagnostics: {
      modelCalls: 0,
      interpretationSource: "precompiled-sample",
      warnings: [],
      durationMs: 0,
      rejected: false,
    },
  });
  const unsigned: Omit<PromotedWorkflow, "workflowSha256"> = {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    applicationProfileId: profile.id,
    state: "Promoted",
    allowedRuntimeOrigins: profile.runtimeOrigins,
    allowedPaths: profile.allowedPaths,
    structuralFingerprint: fingerprint,
    fingerprintVersion: fingerprint.version,
    compileModel: workflow.compileModel,
    promptVersion: "fixture-v1",
    compiledFromSyntheticData: true,
    syntheticAttestationTimestamp: "2026-07-22T00:00:00.000Z",
    selectedLocators: workflow.steps.map(
      (step) => step.selectedLocator!.primary,
    ),
    fallbackLocators: [],
    preconditions: [],
    postconditions: ["Synthetic administrative action staged"],
    confidence: 1,
    approvalTimestamp: "2026-07-22T00:10:00.000Z",
    promotionTimestamp: "2026-07-22T00:11:00.000Z",
    runtimeOpenAIPolicy: "forbidden",
  };
  const promotion: PromotedWorkflow = {
    ...unsigned,
    workflowSha256: computeWorkflowHash(unsigned),
  };

  for (const variant of ["A", "B"]) {
    const result = await runPromotedWorkflowObject({
      workflow,
      promotion,
      profile,
      url: `http://127.0.0.1:4273/ncba-fixture?mode=clinical&variant=${variant}`,
      actualFingerprint: fingerprint,
      targetsUnique: true,
      preconditionsPassed: true,
      humanConfirmed: true,
      options: { headless: true },
    });
    expect(result.preflight.allowed).toBe(true);
    expect(result.telemetry).toMatchObject({
      llmCalls: 0,
      openAIRequests: 0,
      steps: [
        { stepId: "select-test-record", status: "passed" },
        { stepId: "stage-administrative-action", status: "passed" },
      ],
    });
  }
});
