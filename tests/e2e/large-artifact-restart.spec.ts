import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CGI_FIXTURE_INSTRUCTION } from "@visual-compiler/compiler";

const demoOrigin = "http://127.0.0.1:4273";
const studioOrigin = "http://127.0.0.1:3102";
const largeFixtureUrl = `${demoOrigin}/cgi-professional?large=1&patient_id=FAKE-LARGE&mytime=987654`;

async function waitForStudio() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${studioOrigin}/health`);
      if (response.ok) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Restarted Studio did not become healthy.");
}

async function startStudio(storageDirectory: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/studio/backend/src/server.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        USE_LIVE_OPENAI: "false",
        OPENAI_API_KEY: "",
        STUDIO_PORT: "3102",
        DEMO_SITE_INTERNAL_URL: demoOrigin,
        DEMO_SITE_PUBLIC_URL: demoOrigin,
        WORKFLOW_STORAGE_DIR: storageDirectory,
        COMPILER_PROGRESS_DELAY_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForStudio();
  return child;
}

async function stopStudio(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function attestAndCapture(page: Page) {
  await page.goto(studioOrigin);
  await page.getByLabel("Target Website URL").fill(largeFixtureUrl);
  await page.getByLabel("Target Website URL").press("Tab");
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
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  const capture = await (await captureResponsePromise).json();
  await expect(page.locator("#status")).toHaveText("Redacted capture ready");
  await page.locator("#compilerPayloadConfirmation").check();
  return capture;
}

test("a >100 KB artifact is compactly acknowledged, persisted, restarted and restored without GPT", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const storageDirectory = await mkdtemp(
    path.join(tmpdir(), "visual-compiler-large-restart-"),
  );
  let studio = await startStudio(storageDirectory);
  try {
    await attestAndCapture(page);
    let compileRequests = 0;
    page.on("request", (request) => {
      if (
        request.url() === `${studioOrigin}/api/compile` &&
        request.method() === "POST"
      ) {
        compileRequests += 1;
      }
    });
    const compileResponsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${studioOrigin}/api/compile` &&
        response.request().method() === "POST",
    );
    const compileRequestPromise = page.waitForRequest(
      (request) =>
        request.url() === `${studioOrigin}/api/compile` &&
        request.method() === "POST",
    );
    const compileButton = page.getByRole("button", { name: "Compile", exact: true });
    await page.locator("#compile").evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    const outboundCompile = await compileRequestPromise;
    const concurrentBody = outboundCompile.postDataJSON();
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `${studioOrigin}/api/compile-status?id=${encodeURIComponent(concurrentBody.requestId)}`,
        );
        if (!response.ok()) return "missing";
        return (await response.json()).stage;
      })
      .not.toBe("Preparing redacted payload");
    const concurrentResponse = await page.request.post(
      `${studioOrigin}/api/compile`,
      {
        data: {
          ...concurrentBody,
          requestId: "concurrent-large-artifact-request",
        },
      },
    );
    expect(concurrentResponse.status()).toBe(409);
    expect(await concurrentResponse.json()).toMatchObject({
      error: expect.stringContaining("already in progress"),
    });
    const compileResponse = await compileResponsePromise;
    const compileRequestBody = compileResponse.request().postDataJSON();
    const compactText = await compileResponse.text();
    const compact = JSON.parse(compactText);
    expect(compileRequests).toBe(1);
    expect(Buffer.byteLength(compactText)).toBeLessThan(10_000);
    expect(compact.workflow).toBeUndefined();
    expect(compact).toMatchObject({
      workflowId: expect.any(String),
      artifactPath: expect.stringContaining("compiled-workflows/"),
      lifecycle: { state: "Draft" },
      diagnostics: { modelCalls: 0 },
      reused: false,
    });
    await expect(page.locator("#status")).toHaveText(
      "Compilation complete — Draft",
    );
    await expect(page.locator("#compileProgress")).toContainText(
      "Preparing redacted payload",
    );
    await expect(page.locator("#compileProgress")).toContainText(
      "Calling GPT-5.6",
    );
    await expect(page.locator("#compileProgress")).toContainText(
      "Saving artifact",
    );
    await expect(page.locator("#compileProgress")).toContainText(
      "Compilation complete",
    );

    const artifactFile = path.join(
      storageDirectory,
      `${compact.workflowId}.json`,
    );
    expect((await stat(artifactFile)).size).toBeGreaterThan(100_000);
    const stateDirectory = path.join(storageDirectory, ".state");
    const stateFiles = await readdir(stateDirectory);
    const lifecycleStateText = await readFile(
      path.join(stateDirectory, `${compact.workflowId}.lifecycle.json`),
      "utf8",
    );
    expect(stateFiles.some((file) => file.endsWith(".idempotency.json"))).toBe(
      true,
    );
    expect(lifecycleStateText).not.toContain(CGI_FIXTURE_INSTRUCTION);
    expect(lifecycleStateText).not.toContain("patient_id");
    expect(lifecycleStateText).not.toContain("mytime");
    const artifactResponse = await page.request.get(
      `${studioOrigin}/api/workflow?id=${encodeURIComponent(compact.workflowId)}`,
    );
    const artifactText = await artifactResponse.text();
    expect(Buffer.byteLength(artifactText)).toBeGreaterThan(100_000);
    for (const forbidden of [
      "patient_id",
      "mytime",
      "FAKE-LARGE",
      "VALEUR-SYNTHETIQUE-A-SUPPRIMER",
      "AUTRE-VALEUR-SYNTHETIQUE-SECRETE",
      "TOKEN-SYNTHETIQUE-EXCLU",
      "localStorage",
      "sessionStorage",
    ]) {
      expect(artifactText).not.toContain(forbidden);
    }
    const studioSummary = await page.locator("#output").innerText();
    expect(Buffer.byteLength(studioSummary)).toBeLessThan(12_000);
    expect(studioSummary).not.toContain('"candidates"');
    expect(await compileButton.isEnabled()).toBe(true);
    const idempotentResponse = await page.request.post(
      `${studioOrigin}/api/compile`,
      {
        data: {
          ...compileRequestBody,
          requestId: "idempotent-retry-large-artifact",
        },
      },
    );
    expect(idempotentResponse.ok()).toBe(true);
    expect(await idempotentResponse.json()).toMatchObject({
      workflowId: compact.workflowId,
      diagnostics: { modelCalls: 0 },
      reused: true,
    });

    await stopStudio(studio);
    studio = await startStudio(storageDirectory);
    await page.goto(studioOrigin);
    await expect(page.getByLabel("Compiled workflow")).toHaveValue(
      compact.workflowId,
    );
    await expect(page.locator('[data-lifecycle-state="Draft"]')).toHaveClass(
      /active/,
    );
    await expect(page.locator("#status")).toHaveText("Artifact loaded");
    expect(
      Buffer.byteLength(await page.locator("#output").innerText()),
    ).toBeLessThan(12_000);

    await attestAndCapture(page);
    await page.getByLabel("Compiled workflow").selectOption(compact.workflowId);
    await page.locator("#restoreArtifactConfirmation").check();
    const restoreResponsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${studioOrigin}/api/workflows/restore-draft` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Restore compatible Draft" })
      .click();
    const restored = await (await restoreResponsePromise).json();
    expect(restored).toMatchObject({
      workflowId: compact.workflowId,
      lifecycle: { state: "Draft" },
      diagnostics: { modelCalls: 0 },
      reused: true,
      compatibility: {
        structuralCompatibility: 1,
      },
    });
    await expect(page.locator("#status")).toHaveText(
      "Compatible artifact restored — Draft",
    );
    expect(compileRequests).toBe(1);
  } finally {
    await stopStudio(studio);
    await rm(storageDirectory, { recursive: true, force: true });
  }
});
