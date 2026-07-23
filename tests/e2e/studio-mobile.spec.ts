import { expect, test } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  hasTouch: true,
  isMobile: true,
});

test("Studio remains usable at an iPhone Safari viewport", async ({ page }) => {
  const health = await page.request.get("http://127.0.0.1:3100/health");
  await expect(health).toBeOK();
  expect(await health.json()).toMatchObject({
    ok: true,
    storage: { writable: true },
    runtimeOpenAIAllowed: false,
  });

  await page.goto("http://127.0.0.1:3100");

  await expect(
    page.getByRole("heading", { name: "Visual Compiler" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Compile" })).toBeVisible();
  await expect(page.getByLabel("Compiled workflow")).toHaveValue(
    "pending-review.workflow",
  );
  await expect(page.getByTitle("Controlled workflow demo")).toBeVisible();
  await expect(page.locator("#status")).toHaveText("Artifact loaded");
  await expect(page.locator("#compileCalls")).toHaveText("1");
  await expect(page.locator("#compileModel")).toHaveText("gpt-5.6-sol");
  await expect(page.locator("#compileTokens")).toHaveText(/\d+ \/ \d+/);
  await expect(page.locator("#output")).toContainText(
    '"interpretationSource": "gpt-5.6"',
  );

  const layout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    compileHeight: document.getElementById("compile")!.getBoundingClientRect()
      .height,
    columns: getComputedStyle(document.querySelector(".app")!)
      .gridTemplateColumns,
  }));

  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.compileHeight).toBeGreaterThanOrEqual(44);
  expect(layout.columns.split(" ")).toHaveLength(1);

  const replay = await page.request.post("http://127.0.0.1:3100/api/run", {
    data: {
      variant: "A",
      visible: false,
      workflowId: "pending-review.workflow",
    },
  });
  await expect(replay).toBeOK();
  expect((await replay.json()).telemetry).toMatchObject({
    llmCalls: 0,
    openAIRequests: 0,
    finalState: {
      checks: expect.arrayContaining([
        expect.objectContaining({
          kind: "checkbox-state",
          actual: true,
          passed: true,
        }),
      ]),
    },
  });
});
