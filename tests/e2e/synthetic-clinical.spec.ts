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
  await expect(page.getByLabel("Active application profile")).toContainText(
    "SYNTHETIC DATA ONLY",
  );
  await page
    .getByLabel("Application profile", { exact: true })
    .selectOption("ncba-dpi-clinical");
  const clinical = page.getByLabel("Clinical Runtime");
  await expect(clinical).toBeVisible();
  await expect(clinical).toContainText("PROMOTED WORKFLOWS ONLY");
  await expect(page.getByLabel("Training Compilation")).toBeHidden();
  await expect(page.locator("#activeProfileId")).toHaveText(
    "ncba-dpi-clinical",
  );
  await expect(page.locator("#activeMode")).toHaveText("CLINICAL");
  const response = await page.request.post(
    "http://127.0.0.1:3100/api/clinical/compile",
    { data: { instruction: "test" } },
  );
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining("disabled"),
  });
});

test("Studio visibly demonstrates capture through promoted A/B execution", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("http://127.0.0.1:3100/");

  await expect(page.getByText("APPLICATION PROFILE")).toBeVisible();
  await expect(page.locator("#activeMode")).toHaveText("FIXTURE");
  const profileOptions = page
    .getByLabel("Application profile", { exact: true })
    .locator("option");
  await expect(profileOptions.nth(0)).toContainText("ncba-dpi-fixture");
  await expect(profileOptions.nth(1)).toContainText("ncba-dpi-training");
  await expect(profileOptions.nth(2)).toContainText("ncba-dpi-clinical");
  await expect(
    page.getByRole("button", { name: "Open in managed browser" }),
  ).toBeVisible();
  await expect(
    page.getByText(/synthetic environment.*no patient data/i),
  ).toBeVisible();

  const capture = page.getByRole("button", { name: "Capture" });
  const compile = page.getByRole("button", { name: "Compile" });
  await expect(capture).toBeDisabled();
  await expect(compile).toBeDisabled();
  for (const checkbox of await page
    .locator("[data-attestation-key], #indicatorVerified")
    .all()) {
    await checkbox.check();
  }
  await expect(capture).toBeEnabled();
  await capture.click();
  await expect(page.locator("#status")).toHaveText("Redacted capture ready");
  await expect(page.locator("#redactionReport")).toContainText(
    '"cookiesCaptured": false',
  );
  await expect(page.locator("#redactionReport")).toContainText(
    '"storageCaptured": false',
  );
  await expect(page.locator("#redactionReport")).toContainText(
    '"networkCaptured": false',
  );
  await expect(page.locator("#fingerprintReport")).toContainText('"sha256"');
  await expect(compile).toBeEnabled();

  await compile.click();
  await expect(page.locator("#status")).toHaveText("Compiled — Draft");
  await expect(page.locator('[data-lifecycle-state="Draft"]')).toHaveClass(
    /active/,
  );

  await page.getByRole("button", { name: "Validate A/B" }).click();
  await expect(page.locator("#status")).toHaveText("Workflow Validated on A/B");
  await expect(page.locator('[data-lifecycle-state="Validated"]')).toHaveClass(
    /active/,
  );

  await page.locator("#approvalConfirmation").check();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("#status")).toHaveText("Workflow Approved");
  await expect(page.locator('[data-lifecycle-state="Approved"]')).toHaveClass(
    /active/,
  );

  await page.getByRole("button", { name: "Promote", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Workflow Promoted");
  await expect(page.locator('[data-lifecycle-state="Promoted"]')).toHaveClass(
    /active/,
  );
  await expect(page.locator("#preflightReport")).toContainText(
    '"runtimeOpenAIPolicy": "forbidden"',
  );

  await page.locator("#preflightConfirmation").check();
  await page.getByRole("button", { name: "Run preflight" }).click();
  await expect(page.locator("#status")).toHaveText("Preflight passed");
  await expect(page.locator("#preflightReport")).toContainText(
    '"allowed": true',
  );
  await expect(page.locator("#preflightReport")).toContainText(
    '"openAIRequests": 0',
  );

  await page.getByRole("button", { name: "Execute promoted A" }).click();
  await expect(page.locator("#status")).toHaveText(
    "Promoted workflow passed on variant A",
  );
  await expect(page.locator("#fixtureRuntimeResult")).toContainText(
    '"runtimeLlmCalls": 0',
  );
  await expect(page.locator("#fixtureRuntimeResult")).toContainText(
    '"openAIRequests": 0',
  );

  await page.getByRole("button", { name: "Execute promoted B" }).click();
  await expect(page.locator("#status")).toHaveText(
    "Promoted workflow passed on variant B",
  );

  await page
    .getByLabel("Application profile", { exact: true })
    .selectOption("ncba-dpi-clinical");
  await expect(page.locator("#activeMode")).toHaveText("CLINICAL");
  await expect(page.getByLabel("Training Compilation")).toBeHidden();
  await expect(page.getByLabel("Clinical Runtime")).toBeVisible();
  await expect(page.getByLabel("Promoted workflow")).toContainText(
    "Pending review",
  );
  await expect(page.getByLabel("Clinical Runtime")).toContainText(
    "OPENAI ACCESS FORBIDDEN",
  );
});

test("profile selection never contacts NCBA and compilation is attestation-gated", async ({
  page,
}) => {
  const ncbaRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("dpi-ncba.gbna-sante.fr")) {
      ncbaRequests.push(request.url());
    }
  });
  await page.goto("http://127.0.0.1:3100/");
  const profile = page.getByLabel("Application profile", { exact: true });
  expect(
    await profile
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).toEqual(["ncba-dpi-fixture", "ncba-dpi-training", "ncba-dpi-clinical"]);

  await profile.selectOption("ncba-dpi-training");
  await expect(page.locator("#activeProfileId")).toHaveText(
    "ncba-dpi-training",
  );
  await expect(page.locator("#activeMode")).toHaveText("TRAINING");
  await expect(page.getByLabel("Target Website URL")).toHaveValue(
    "https://dpi-ncba.gbna-sante.fr/",
  );
  await expect(page.getByTitle("Controlled workflow demo")).toHaveAttribute(
    "srcdoc",
    /Studio will not contact/,
  );
  await expect(page.getByRole("button", { name: "Compile" })).toBeDisabled();
  expect(ncbaRequests).toEqual([]);

  const missingAttestation = await page.request.post(
    "http://127.0.0.1:3100/api/compile",
    {
      data: {
        studioProfileId: "ncba-dpi-training",
        targetUrl: "https://dpi-ncba.gbna-sante.fr/",
        instruction: "Synthetic administrative test",
      },
    },
  );
  expect(missingAttestation.status()).toBe(403);

  const noExplicitOpen = await page.request.post(
    "http://127.0.0.1:3100/api/managed-browser/open",
    {
      data: {
        studioProfileId: "ncba-dpi-training",
        targetUrl: "https://dpi-ncba.gbna-sante.fr/",
        explicitUserAction: false,
      },
    },
  );
  expect(noExplicitOpen.status()).toBe(400);

  const completeAttestation = await page.request.post(
    "http://127.0.0.1:3100/api/compile",
    {
      data: {
        studioProfileId: "ncba-dpi-training",
        targetUrl: "https://dpi-ncba.gbna-sante.fr/",
        instruction: "Synthetic administrative test",
        syntheticAttestation: {
          profileId: "ncba-dpi",
          statements: {
            authorizedTrainingEnvironment: true,
            syntheticDataOnly: true,
            noRealPatientDataVisible: true,
            noCredentialOrSecretSentToOpenAI: true,
            administrativeAndReversible: true,
          },
          syntheticIndicator: "training-banner",
          indicatorVerifiedLocally: true,
          attestedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(completeAttestation.status()).toBe(409);
  expect(await completeAttestation.json()).toMatchObject({
    error: expect.stringContaining("fresh attested capture"),
  });

  const clinicalCompile = await page.request.post(
    "http://127.0.0.1:3100/api/compile",
    {
      data: {
        studioProfileId: "ncba-dpi-clinical",
        targetUrl: "https://dpi-ncba.gbna-sante.fr/",
      },
    },
  );
  expect(clinicalCompile.status()).toBe(403);
  expect(await clinicalCompile.json()).toMatchObject({
    error: expect.stringContaining("disabled in clinical"),
  });
  expect(ncbaRequests).toEqual([]);
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
