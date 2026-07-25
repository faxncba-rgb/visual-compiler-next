import { expect, test } from "@playwright/test";
import { CGI_FIXTURE_INSTRUCTION } from "@visual-compiler/compiler";
import { runWorkflowObject } from "@visual-compiler/runtime";
import { SemanticWorkflowSchema } from "@visual-compiler/semantic-ir";

const studioOrigin = "http://127.0.0.1:3100";
const cgiUrl =
  "http://127.0.0.1:4273/cgi-professional?patient_id=FAKE-CGI-E2E&mytime=123456";

test("a CGI-style page without stable test labels compiles textarea and Save locator candidates offline", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(studioOrigin);
  await page.getByLabel("Target Website URL").fill(cgiUrl);
  await page.getByLabel("Target Website URL").press("Tab");
  await expect(page.locator("#targetValidation")).toContainText(
    "http://127.0.0.1:4273/cgi-professional",
  );
  await expect(page.locator("#targetValidation")).not.toContainText(
    "patient_id",
  );
  await page.getByLabel("Workflow instruction").fill(CGI_FIXTURE_INSTRUCTION);
  for (const checkbox of await page
    .locator("[data-attestation-key], #indicatorVerified")
    .all()) {
    await checkbox.check();
  }

  const captureResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${studioOrigin}/api/capture` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Capture" }).click();
  const captureBody = await (await captureResponsePromise).json();
  await expect(page.locator("#status")).toHaveText("Redacted capture ready");
  const previewText = await page.locator("#compilerPayloadPreview").innerText();
  const preview = JSON.parse(previewText);
  expect(preview).toMatchObject({
    origin: "http://127.0.0.1:4273",
    path: "/cgi-professional",
    textPolicy: {
      arbitraryContentIncluded: false,
      formValuesIncluded: false,
    },
    redactionReport: {
      interactiveElements: expect.any(Number),
      accessibleNamesKept: expect.any(Number),
      labelsKept: expect.any(Number),
      valuesRemoved: expect.any(Number),
      cookiesCaptured: false,
      storageCaptured: false,
      networkCaptured: false,
    },
  });
  expect(preview.redactionReport.interactiveElements).toBeGreaterThanOrEqual(4);
  expect(preview.redactionReport.accessibleNamesKept).toBeGreaterThanOrEqual(4);
  expect(preview.redactionReport.labelsKept).toBeGreaterThanOrEqual(2);
  expect(preview.redactionReport.valuesRemoved).toBeGreaterThanOrEqual(2);
  expect(preview.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        tagName: "textarea",
        role: "textbox",
        accessibleName: "Observation du praticien",
        labelText: "Observation du praticien",
      }),
      expect.objectContaining({
        tagName: "button",
        role: "button",
        accessibleName: "Enregistrer",
        controlText: "Enregistrer",
      }),
    ]),
  );
  for (const forbidden of [
    "VALEUR-SYNTHETIQUE-A-SUPPRIMER",
    "AUTRE-VALEUR-SYNTHETIQUE-SECRETE",
    "TOKEN-SYNTHETIQUE-EXCLU",
    "patient_id",
    "mytime",
    "FAKE-CGI-E2E",
    "data-vc-stable-label",
  ]) {
    expect(previewText).not.toContain(forbidden);
  }

  const unconfirmedCompile = await page.request.post(
    `${studioOrigin}/api/compile`,
    {
      data: {
        instruction: CGI_FIXTURE_INSTRUCTION,
        studioProfileId: "ncba-dpi-fixture",
        targetUrl: cgiUrl,
        captureId: captureBody.captureId,
        compilerPayloadSha256: captureBody.compilerPayloadSha256,
        compilerPayloadConfirmed: false,
        syntheticAttestation: {
          profileId: "ncba-dpi-fixture",
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
  expect(unconfirmedCompile.status()).toBe(428);
  expect(await unconfirmedCompile.json()).toMatchObject({
    error: expect.stringContaining("confirm"),
  });

  await expect(page.getByRole("button", { name: "Compile" })).toBeDisabled();
  await page.locator("#compilerPayloadConfirmation").check();
  await expect(page.getByRole("button", { name: "Compile" })).toBeEnabled();
  const compactCompileResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${studioOrigin}/api/compile` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Compile" }).click();
  await expect(page.locator("#status")).toContainText("Draft");
  const compactResponse = await compactCompileResponsePromise;
  const compactText = await compactResponse.text();
  const compactBody = JSON.parse(compactText);
  expect(Buffer.byteLength(compactText)).toBeLessThan(10_000);
  expect(compactBody).toMatchObject({
    workflowId: expect.any(String),
    artifactPath: expect.stringContaining("compiled-workflows/"),
    lifecycle: { state: "Draft" },
    diagnostics: {
      modelCalls: 0,
      locatorDiagnostics: expect.any(Array),
    },
  });
  expect(compactBody.workflow).toBeUndefined();
  const artifactResponse = await page.request.get(
    `${studioOrigin}/api/workflow?id=${encodeURIComponent(compactBody.workflowId)}`,
  );
  expect(artifactResponse.ok()).toBe(true);
  const workflow = SemanticWorkflowSchema.parse(await artifactResponse.json());
  const studioSummary = JSON.parse(await page.locator("#output").innerText());
  expect(studioSummary).toMatchObject({
    workflowId: workflow.id,
    stepCount: 2,
  });
  expect(studioSummary.steps[0].candidates).toBeUndefined();
  await expect(page.locator("#compileProgress")).toContainText(
    "Preparing redacted payload",
  );
  await expect(page.locator("#compileProgress")).toContainText(
    "Compilation complete",
  );
  expect(workflow.steps.map((step) => step.action)).toEqual(["fill", "click"]);
  expect(workflow.steps[0].target.accessibleName).toBe(
    "Observation du praticien",
  );
  expect(workflow.steps[1].target.accessibleName).toBe("Enregistrer");
  expect(workflow.steps.every((step) => step.candidates.length > 0)).toBe(true);
  expect(workflow.steps[0].selectedLocator?.rule?.candidateRole).toBe(
    "textbox",
  );
  expect(workflow.steps[1].selectedLocator?.primary).toContain("near-dom");
  expect(workflow.diagnostics.locatorDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        stepId: "fill-administrative-observation",
        candidateCount: expect.any(Number),
      }),
      expect.objectContaining({
        stepId: "save-administrative-observation",
        candidateCount: expect.any(Number),
      }),
    ]),
  );
  const artifact = JSON.stringify(workflow);
  for (const forbidden of [
    "VALEUR-SYNTHETIQUE-A-SUPPRIMER",
    "AUTRE-VALEUR-SYNTHETIQUE-SECRETE",
    "TOKEN-SYNTHETIQUE-EXCLU",
    "patient_id",
    "mytime",
    "FAKE-CGI-E2E",
  ]) {
    expect(artifact).not.toContain(forbidden);
  }
  expect(workflow.diagnostics.modelCalls).toBe(0);

  const telemetry = await runWorkflowObject(workflow, cgiUrl, {
    headless: true,
  });
  expect(telemetry.steps).toEqual([
    expect.objectContaining({
      stepId: "fill-administrative-observation",
      action: "fill",
      status: "passed",
    }),
    expect.objectContaining({
      stepId: "save-administrative-observation",
      action: "click",
      status: "passed",
    }),
  ]);
  expect(telemetry.finalState?.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "input-value",
        target: "Observation du praticien",
        expected: "test du DR LEROY",
        actual: "test du DR LEROY",
        passed: true,
      }),
      expect.objectContaining({
        kind: "text-visible",
        target: "Enregistrement synthétique effectué",
        passed: true,
      }),
    ]),
  );
  expect(telemetry.llmCalls).toBe(0);
  expect(telemetry.openAIRequests).toBe(0);
});
