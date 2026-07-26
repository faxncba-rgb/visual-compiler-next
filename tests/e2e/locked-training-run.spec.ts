import { expect, test } from "@playwright/test";
import { CGI_FIXTURE_INSTRUCTION } from "@visual-compiler/compiler";

const studioOrigin = "http://127.0.0.1:3100";
const applicationOrigin = "http://127.0.0.1:4273";
const ssoCgiTarget = `${applicationOrigin}/sso-cgi/start?patient_id=FAKE-LOCKED-TRAINING&mytime=123456`;

async function attest(page: import("@playwright/test").Page) {
  for (const checkbox of await page
    .locator("[data-attestation-key], #indicatorVerified")
    .all()) {
    await checkbox.check();
  }
}

async function openAuthenticateAndLock(
  page: import("@playwright/test").Page,
) {
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  const openButton = page.getByRole("button", {
    name: "Open in managed browser",
  });
  await expect(openButton).toBeEnabled();
  const openResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${studioOrigin}/api/managed-browser/open` &&
      response.request().method() === "POST",
  );
  await openButton.click();
  const openResponse = await openResponsePromise;
  expect(openResponse.ok(), await openResponse.text()).toBe(true);
  await expect(page.locator("#authenticationState")).toContainText(
    "AUTHENTICATION IN PROGRESS",
  );
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${studioOrigin}/api/managed-browser/status/ncba-dpi-training`,
      );
      return (await response.json()).currentOrigin;
    })
    .toBe("http://127.0.0.1:4275");
  const continuation = await page.request.post(
    `${studioOrigin}/api/test-only/sso/continue`,
    { data: { flow: "redirect" } },
  );
  expect(
    continuation.ok(),
    JSON.stringify(await continuation.json()),
  ).toBe(true);
  await expect(
    page.getByRole("button", {
      name: "Authentication complete — lock to application",
    }),
  ).toBeEnabled();
  await page
    .getByRole("button", {
      name: "Authentication complete — lock to application",
    })
    .click();
  await expect(page.locator("#authenticationState")).toContainText(
    "APPLICATION LOCKED",
  );
}

async function capture(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Redacted capture ready");
  await page.locator("#compilerPayloadConfirmation").check();
}

test("locked Training page runs an explicitly confirmed Draft on the existing managed session", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(studioOrigin);
  await page
    .getByLabel("Application profile", { exact: true })
    .selectOption("ncba-dpi-training");
  await page.getByLabel("Target Website URL").fill(ssoCgiTarget);
  await page.getByLabel("Target Website URL").press("Tab");
  await expect(page.locator("#targetValidation")).toContainText(
    `${applicationOrigin}/sso-cgi/start`,
  );
  await expect(page.locator("#targetValidation")).not.toContainText(
    "patient_id",
  );
  await page.getByLabel("Workflow instruction").fill(CGI_FIXTURE_INSTRUCTION);
  await attest(page);
  await openAuthenticateAndLock(page);
  await capture(page);

  const compileResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${studioOrigin}/api/compile` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Compile", exact: true }).click();
  const compileResponse = await compileResponsePromise;
  expect(
    compileResponse.ok(),
    await compileResponse.text(),
  ).toBe(true);
  await expect(page.locator("#status")).toContainText("Draft", {
    timeout: 20_000,
  });
  await expect(
    page.locator(
      '#trainingExecutionPanel [data-training-lifecycle-state="Draft"]',
    ),
  ).toHaveClass(/active/);

  const wrongPath = await page.request.post(
    `${studioOrigin}/api/test-only/training/navigate`,
    { data: { destination: "wrong-path" } },
  );
  expect(wrongPath.ok()).toBe(true);
  const wrongPathPreflight = await page.request.post(
    `${studioOrigin}/api/training/preflight`,
    {
      data: {
        studioProfileId: "ncba-dpi-training",
        workflowId: await page
          .getByLabel("Compiled workflow")
          .inputValue(),
      },
    },
  );
  expect(wrongPathPreflight.status()).toBe(409);
  expect(await wrongPathPreflight.json()).toMatchObject({
    error: expect.stringContaining("pathname"),
    llmCalls: 0,
    openAIRequests: 0,
  });
  await page.request.post(`${studioOrigin}/api/test-only/training/navigate`, {
    data: { destination: "cgi" },
  });

  const outside = await page.request.post(
    `${studioOrigin}/api/test-only/sso/attempt-exit`,
  );
  expect(await outside.json()).toMatchObject({
    blocked: true,
    phase: "application-locked",
    llmCalls: 0,
    openAIRequests: 0,
  });

  await openAuthenticateAndLock(page);
  const differentSessionPreflight = await page.request.post(
    `${studioOrigin}/api/training/preflight`,
    {
      data: {
        studioProfileId: "ncba-dpi-training",
        workflowId: await page
          .getByLabel("Compiled workflow")
          .inputValue(),
      },
    },
  );
  expect(differentSessionPreflight.status()).toBe(409);
  expect(await differentSessionPreflight.json()).toMatchObject({
    error: expect.stringContaining("session used for this capture"),
    llmCalls: 0,
    openAIRequests: 0,
  });

  await capture(page);
  await page.locator("#restoreArtifactConfirmation").check();
  await page.getByRole("button", { name: "Restore compatible Draft" }).click();
  await expect(page.locator("#status")).toHaveText(
    "Compatible artifact restored — Draft",
  );

  const trainingPanel = page.getByLabel("Locked Training execution");
  await expect(trainingPanel).toBeVisible();
  await expect(trainingPanel).toContainText("Training synthetic data only");
  const runButton = page.getByRole("button", {
    name: "Test run on locked Training page",
  });
  await expect(runButton).toBeDisabled();
  await page
    .getByRole("button", { name: "Prepare Training test preflight" })
    .click();
  await expect(page.locator("#status")).toHaveText(
    "Locked Training preflight passed",
  );
  await expect(page.locator("#trainingPlannedActions")).toContainText(
    '"action": "fill"',
  );
  await expect(page.locator("#trainingPlannedActions")).toContainText(
    '"action": "click"',
  );
  await expect(page.locator("#trainingPlannedActions")).toContainText(
    '"selectedLocatorUnique": true',
  );
  await expect(page.locator("#trainingPlannedActions")).toContainText(
    "test du DR LEROY",
  );
  await expect(page.locator("#trainingExecutionPreflightResult")).toContainText(
    '"sameManagedSession": true',
  );
  await expect(page.locator("#trainingExecutionPreflightResult")).toContainText(
    '"openAIRequests": 0',
  );

  await page
    .getByLabel(
      "I confirm execution on the currently displayed synthetic Training record.",
    )
    .check();
  await expect(runButton).toBeEnabled();
  await runButton.click();
  await expect(page.locator("#status")).toHaveText(
    "Training test passed — Draft marked Validated",
  );
  await expect(
    page.locator(
      '#trainingExecutionPanel [data-training-lifecycle-state="Validated"]',
    ),
  ).toHaveClass(/active/);
  await expect(page.locator("#trainingExecutionTelemetry")).toContainText(
    '"status": "passed"',
  );
  await expect(page.locator("#trainingExecutionTelemetry")).toContainText(
    '"runtimeLlmCalls": 0',
  );
  await expect(page.locator("#trainingExecutionTelemetry")).toContainText(
    '"openAIRequests": 0',
  );
  const syntheticState = await page.request.get(
    `${studioOrigin}/api/test-only/training/cgi-state`,
  );
  expect(await syntheticState.json()).toEqual({
    expectedSyntheticValuePresent: true,
    secondSyntheticValuePresent: false,
    savePostconditionVisible: true,
    llmCalls: 0,
    openAIRequests: 0,
  });

  await page.request.delete(
    `${studioOrigin}/api/browser-profiles/ncba-dpi-training`,
  );
});
