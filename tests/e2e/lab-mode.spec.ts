import { expect, test, type Page } from "@playwright/test";
import {
  CGI_FIXTURE_INSTRUCTION,
  CGI_FIXTURE_SECOND_INSTRUCTION,
} from "@visual-compiler/compiler";

const studioOrigin = "http://127.0.0.1:3100";
const applicationOrigin = "http://127.0.0.1:4273";
const target = `${applicationOrigin}/sso-cgi/start?patient_id=FAKE-LAB&mytime=654321`;

async function authenticateAndLock(page: Page) {
  const openResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${studioOrigin}/api/managed-browser/open` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Open in managed browser" }).click();
  expect((await openResponsePromise).ok()).toBe(true);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${studioOrigin}/api/managed-browser/status/ncba-dpi-training`,
      );
      return (await response.json()).currentOrigin;
    })
    .toBe("http://127.0.0.1:4275");
  expect(
    (
      await page.request.post(`${studioOrigin}/api/test-only/sso/continue`, {
        data: { flow: "redirect" },
      })
    ).ok(),
  ).toBe(true);
  await page
    .getByRole("button", {
      name: "Authentication complete — lock to application",
    })
    .click();
  await expect(page.locator("#authenticationState")).toContainText(
    "APPLICATION LOCKED",
  );
}

test("Lab Mode confirms once, auto-captures, falls back on legacy CGI, reruns and recompiles", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(studioOrigin);
  const labPanel = page.getByLabel("Visual Compiler Lab Mode");
  await expect(labPanel).toBeVisible();
  await expect(labPanel).toContainText("LAB MODE — SYNTHETIC TEST ENVIRONMENT");

  await page
    .getByLabel("Application profile", { exact: true })
    .selectOption("ncba-dpi-clinical");
  await expect(labPanel).toBeHidden();
  const clinicalConfirmation = await page.request.post(
    `${studioOrigin}/api/lab/confirm`,
    {
      data: {
        studioProfileId: "ncba-dpi-clinical",
        confirmed: true,
      },
    },
  );
  expect(clinicalConfirmation.status()).toBe(403);

  await page
    .getByLabel("Application profile", { exact: true })
    .selectOption("ncba-dpi-training");
  await page.getByLabel("Target Website URL").fill(target);
  await page.getByLabel("Target Website URL").press("Tab");
  await expect(page.locator("#targetValidation")).toContainText(
    `${applicationOrigin}/sso-cgi/start`,
  );
  await page.getByLabel("Workflow instruction").fill(CGI_FIXTURE_INSTRUCTION);

  await page
    .getByLabel(
      "I confirm that this session contains only synthetic test records.",
    )
    .check();
  await page
    .getByRole("button", { name: "Confirm once for this session" })
    .click();
  await expect(labPanel).toContainText("CONFIRMATION UNIQUE");
  await expect(page.getByLabel("Synthetic data attestation")).toBeHidden();
  await authenticateAndLock(page);

  await expect(page.locator("#labCompile")).toBeEnabled();
  await page.locator("#labCompile").click();
  await expect
    .poll(async () => page.locator("#status").innerText(), { timeout: 20_000 })
    .toMatch(/Draft|Failed/);
  if ((await page.locator("#status").innerText()).includes("Failed")) {
    throw new Error(
      `Lab compilation failed: ${await page.locator("#output").innerText()} ${await page.locator("#labResult").innerText()}`,
    );
  }
  await expect(page.locator("#labResult")).toContainText(/Compilation|reused/);
  await expect(page.locator("#labResult")).toContainText(
    "offline-mock (no model served)",
  );
  await expect(page.locator("#compilerPayloadPreview")).not.toContainText(
    "patient_id",
  );
  await expect(page.locator("#compilerPayloadPreview")).not.toContainText(
    "mytime",
  );
  await expect(page.locator("#compilerPayloadPreview")).not.toContainText(
    "VALEUR-SYNTHETIQUE-A-SUPPRIMER",
  );
  await expect(page.locator("#compilerPayloadPreview")).not.toContainText(
    "SYNTHETIC-CROSS-FRAME-TOKEN",
  );
  await expect(page.locator("#compilerPayloadPreview")).toContainText(
    "/cgi-frame",
  );

  await page.request.post(`${studioOrigin}/api/test-only/training/navigate`, {
    data: { destination: "wrong-path" },
  });
  await page.locator("#labRun").click();
  await expect(page.locator("#status")).toContainText(/failed/i);
  await page.request.post(`${studioOrigin}/api/test-only/training/navigate`, {
    data: { destination: "cgi" },
  });
  await page.locator("#labRun").click();
  await expect
    .poll(async () => page.locator("#status").innerText())
    .toMatch(/Lab run passed|Lab run failed/);
  if ((await page.locator("#status").innerText()).includes("failed")) {
    throw new Error(
      `Lab run failed: ${await page.locator("#labResult").innerText()}`,
    );
  }
  await expect(page.locator("#labResult")).toContainText(
    "Primary unavailable — deterministic fallback selected.",
  );
  await expect(page.locator("#labResult")).toContainText(
    '"fallbackSelected": true',
  );
  await expect(page.locator("#labResult")).toContainText('"llmCalls": 0');
  await expect(page.locator("#labResult")).toContainText('"openAIRequests": 0');
  await expect(page.locator("#labRuntimePhase")).toHaveText(
    "Compilation-independent Lab execution complete.",
  );
  await expect(page.locator("#labResult")).toContainText(
    '"phase": "actionability"',
  );
  await expect(page.locator("#labResult")).toContainText('"editableCount":');
  const firstState = await page.request.get(
    `${studioOrigin}/api/test-only/training/cgi-state`,
  );
  expect(await firstState.json()).toMatchObject({
    expectedSyntheticValuePresent: true,
    savePostconditionVisible: true,
    llmCalls: 0,
    openAIRequests: 0,
  });

  await expect(page.locator("#labRunAgain")).toBeEnabled();
  await page.locator("#labRunAgain").click();
  await expect(page.locator("#status")).toHaveText(
    "Lab run passed — ready to run again",
  );

  const firstWorkflowId = await page
    .getByLabel("Compiled workflow")
    .inputValue();
  await page
    .getByLabel("Workflow instruction")
    .fill(CGI_FIXTURE_SECOND_INSTRUCTION);
  await page.locator("#labCompile").click();
  await expect
    .poll(async () => page.getByLabel("Compiled workflow").inputValue())
    .not.toBe(firstWorkflowId);
  await expect(page.locator("#labResult")).toContainText('"modelCalls": 0');
  await page.locator("#labRun").click();
  await expect(page.locator("#status")).toHaveText(
    "Lab run passed — ready to run again",
  );
  const secondState = await page.request.get(
    `${studioOrigin}/api/test-only/training/cgi-state`,
  );
  expect(await secondState.json()).toMatchObject({
    secondSyntheticValuePresent: true,
    savePostconditionVisible: true,
  });

  await page.request.post(`${studioOrigin}/api/test-only/training/navigate`, {
    data: { destination: "modified" },
  });
  const beforeRecaptureId = await page
    .getByLabel("Compiled workflow")
    .inputValue();
  await page.locator("#labRecaptureCompile").click();
  await expect
    .poll(async () => page.getByLabel("Compiled workflow").inputValue())
    .not.toBe(beforeRecaptureId);

  const stop = await page.request.post(`${studioOrigin}/api/lab/stop`, {
    data: {
      studioProfileId: "ncba-dpi-training",
      labSessionToken: await page.evaluate(
        () => (window as unknown as { __unused?: string }).__unused,
      ),
    },
  });
  // The visible button exercises the authenticated in-page token instead.
  expect(stop.status()).toBe(403);
  await page.locator("#labStop").evaluate((button: HTMLButtonElement) => {
    button.disabled = false;
    button.click();
  });
  await expect(page.locator("#labResult")).toContainText(
    '"sessionPreserved": true',
  );
  await expect(page.locator("#labCompile")).toBeEnabled();

  await page.locator("#labReset").click();
  await expect(labPanel).toContainText(
    "I confirm that this session contains only synthetic test records.",
  );
  await page.request.delete(
    `${studioOrigin}/api/browser-profiles/ncba-dpi-training`,
  );
});
