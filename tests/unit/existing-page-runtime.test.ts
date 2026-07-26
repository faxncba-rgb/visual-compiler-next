import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  inspectWorkflowOnExistingPage,
  runWorkflowOnExistingPage,
} from "@visual-compiler/runtime";
import {
  SemanticWorkflowSchema,
  type SemanticStep,
} from "@visual-compiler/semantic-ir";
import { extractPageModel } from "@visual-compiler/page-model";
import { createRedactedCompilerPageModel } from "@visual-compiler/compiler";

const origin = "https://training.example.test";
let browser: Browser;
let page: Page;

function workflow(steps: SemanticStep[]) {
  return SemanticWorkflowSchema.parse({
    id: "locked-training-test",
    version: "0.1.0",
    name: "Locked Training test",
    source: {
      url: `${origin}/cgi-professional`,
      viewport: { width: 1280, height: 720 },
    },
    steps,
    generatedPlaywright: "// deterministic fixture",
    compiledAt: "2026-07-25T10:00:00.000Z",
    compileModel: "mock",
    metadata: {
      compilerVersion: "0.1.0",
      targetUrl: `${origin}/cgi-professional`,
    },
    diagnostics: {
      modelCalls: 0,
      interpretationSource: "mock",
      warnings: [],
      locatorDiagnostics: [],
      durationMs: 1,
      rejected: false,
    },
  });
}

function step(input: {
  id: string;
  action: "fill" | "click";
  primary: string;
  role: "textbox" | "button";
  name?: string;
  value?: string;
  postconditions?: SemanticStep["postconditions"];
}): SemanticStep {
  return {
    id: input.id,
    action: input.action,
    intent: input.id,
    target: {
      role: input.role,
      accessibleName: input.name,
      state: "enabled",
      relations: [],
    },
    ...(input.value !== undefined ? { value: input.value } : {}),
    preconditions: [
      { type: "element-visible", target: input.id, expected: true },
      { type: "element-enabled", target: input.id, expected: true },
    ],
    postconditions: input.postconditions ?? [],
    candidates: [
      {
        strategy: input.name ? "role-name" : "relative-dom",
        selector: input.primary,
        confidence: 0.9,
        unique: true,
        stability: 0.9,
        explanation: "Synthetic deterministic locator.",
        fallbackOrder: 0,
      },
    ],
    selectedLocator: {
      kind: "semantic-rule",
      primary: input.primary,
      rule: {
        candidateRole: input.role,
        candidateText: input.name,
        ordinal: 1,
        enabledOnly: true,
        visibleOnly: true,
      },
      confidence: 0.9,
      explanation: "Synthetic deterministic locator.",
    },
  };
}

beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route(`${origin}/**`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>
        <label for="note">Observation du praticien</label>
        <textarea id="note"></textarea>
        <button type="button">Enregistrer</button>
        <button type="button">Enregistrer</button>
        <p id="result">Pending</p>
        <script>
          document.querySelector("button").addEventListener("click", () => {
            document.getElementById("result").textContent = "Saved";
          });
        </script>
      </main>`,
    });
  });
  page = await context.newPage();
  await page.goto(`${origin}/cgi-professional`);
});

afterEach(async () => {
  await browser.close();
});

describe("existing managed Page runtime", () => {
  test("models a legacy onclick anchor without inventing a link role or retaining JavaScript", async () => {
    await page.setContent(
      `<a onclick="window.SENSITIVE_HANDLER_CONTENT='never retain this'">Enregistrer</a>`,
    );
    const model = await extractPageModel(page);
    const anchor = model.nodes.find((node) => node.tagName === "a");
    expect(anchor).toMatchObject({
      tagName: "a",
      controlText: "Enregistrer",
      hasClickHandler: true,
    });
    expect(anchor?.role).toBeUndefined();
    expect(anchor?.attributes.onclick).toBeUndefined();
    const serialized = JSON.stringify(createRedactedCompilerPageModel(model));
    expect(serialized).toContain('"hasClickHandler":true');
    expect(serialized).not.toContain("SENSITIVE_HANDLER_CONTENT");
    expect(serialized).not.toContain("never retain this");
  });

  test("fills then clicks on the same page with redacted zero-OpenAI telemetry", async () => {
    const selected = workflow([
      step({
        id: "fill-note",
        action: "fill",
        primary: "role=textbox >> nth=0",
        role: "textbox",
        value: "SYNTHETIC TEST VALUE",
      }),
      step({
        id: "save-note",
        action: "click",
        primary: "role=button >> nth=0",
        role: "button",
        postconditions: [
          { type: "text-visible", target: "Saved", expected: "Saved" },
        ],
      }),
    ]);
    const planned = await inspectWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
    });
    expect(planned.map((action) => action.locator.unique)).toEqual([
      true,
      true,
    ]);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
    });
    expect(await page.getByRole("textbox").inputValue()).toBe(
      "SYNTHETIC TEST VALUE",
    );
    await expect.poll(async () => page.locator("#result").textContent()).toBe(
      "Saved",
    );
    expect(telemetry.steps.map((item) => item.status)).toEqual([
      "passed",
      "passed",
    ]);
    expect(telemetry.llmCalls).toBe(0);
    expect(telemetry.openAIRequests).toBe(0);
    expect(JSON.stringify(telemetry)).not.toContain("SYNTHETIC TEST VALUE");
  });

  test("rejects ambiguous role/name locators and a wrong origin", async () => {
    const ambiguous = workflow([
      step({
        id: "ambiguous-save",
        action: "click",
        primary: 'role=button[name="Enregistrer"]',
        role: "button",
        name: "Enregistrer",
      }),
    ]);
    await expect(
      inspectWorkflowOnExistingPage({
        page,
        workflow: ambiguous,
        expectedOrigin: origin,
      }),
    ).rejects.toThrow(/primary matches=2, visible=2, enabled=2/);
    await expect(
      inspectWorkflowOnExistingPage({
        page,
        workflow: ambiguous,
        expectedOrigin: "https://other.example.test",
      }),
    ).rejects.toThrow(/left its locked application origin/);
  });

  test("stops immediately at the first failed step without executing the next", async () => {
    const failing = workflow([
      step({
        id: "missing-field",
        action: "fill",
        primary: "role=textbox >> nth=4",
        role: "textbox",
        value: "SHOULD NOT BE USED",
      }),
      step({
        id: "must-not-click",
        action: "click",
        primary: "role=button >> nth=0",
        role: "button",
      }),
    ]);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: failing,
      expectedOrigin: origin,
    });
    expect(telemetry.steps).toEqual([
      expect.objectContaining({
        stepId: "missing-field",
        status: "failed",
      }),
    ]);
    expect(await page.locator("#result").textContent()).toBe("Pending");
    expect(JSON.stringify(telemetry)).not.toContain("SHOULD NOT BE USED");
  });

  test("honors an operator stop signal and preserves the existing page session", async () => {
    const controller = new AbortController();
    controller.abort();
    const stopped = workflow([
      step({
        id: "must-not-fill",
        action: "fill",
        primary: "role=textbox >> nth=0",
        role: "textbox",
        value: "MUST NOT BE WRITTEN",
      }),
      step({
        id: "must-not-click-after-stop",
        action: "click",
        primary: "role=button >> nth=0",
        role: "button",
      }),
    ]);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: stopped,
      expectedOrigin: origin,
      signal: controller.signal,
    });
    expect(telemetry.steps).toEqual([
      expect.objectContaining({
        stepId: "must-not-fill",
        status: "failed",
        errorRedacted: "Execution stopped by operator.",
      }),
    ]);
    expect(await page.getByRole("textbox").inputValue()).toBe("");
    expect(await page.locator("#result").textContent()).toBe("Pending");
    expect(page.isClosed()).toBe(false);
    expect(JSON.stringify(telemetry)).not.toContain("MUST NOT BE WRITTEN");
    expect(telemetry.llmCalls).toBe(0);
    expect(telemetry.openAIRequests).toBe(0);
  });

  test("falls back from a missing link role to one legacy onclick anchor", async () => {
    await page.setContent(`<!doctype html><main><section>
      <label for="legacy-note">Observation du praticien</label>
      <textarea id="legacy-note"></textarea>
      <a onclick="document.querySelector('#legacy-result').textContent='Saved'">Enregistrer</a>
      <span>Enregistrer</span><p id="legacy-result">Pending</p>
    </section></main>`);
    const legacy = workflow([
      step({
        id: "fill-legacy",
        action: "fill",
        primary: "role=textbox >> nth=0",
        role: "textbox",
        value: "SYNTHETIC LEGACY VALUE",
      }),
      step({
        id: "save-legacy",
        action: "click",
        primary: 'role=link[name="Enregistrer"]',
        role: "button",
        name: "Enregistrer",
        postconditions: [
          { type: "text-visible", target: "Saved", expected: "Saved" },
        ],
      }),
    ]);
    legacy.steps[1].target.role = "link";
    legacy.steps[1].selectedLocator!.rule!.candidateRole = "link";
    legacy.steps[1].candidates.push({
      strategy: "role-name",
      selector: 'a:text-is("Enregistrer")',
      confidence: 0.9,
      unique: true,
      stability: 0.85,
      explanation: "Legacy onclick anchor text fallback.",
      fallbackOrder: 1,
    });
    const planned = await inspectWorkflowOnExistingPage({
      page,
      workflow: legacy,
      expectedOrigin: origin,
    });
    expect(planned[1].locator).toMatchObject({
      primaryLocator: 'role=link[name="Enregistrer"]',
      selectedLocator: 'a:text-is("Enregistrer")',
      fallbackSelected: true,
      fallbackReason:
        "Primary unavailable — deterministic fallback selected.",
      matchCount: 1,
      visibleCount: 1,
      enabledCount: 1,
    });
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: legacy,
      expectedOrigin: origin,
    });
    expect(telemetry.steps[1]).toMatchObject({
      status: "passed",
      locatorUsed: 'a:text-is("Enregistrer")',
      fallbackSelected: true,
    });
    expect(await page.locator("#legacy-result").textContent()).toBe("Saved");
    expect(telemetry.llmCalls).toBe(0);
    expect(telemetry.openAIRequests).toBe(0);
  });

  test("resolves and executes inside a same-origin frame", async () => {
    await page.context().route(`${origin}/frame`, async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<label for="frame-note">Frame observation</label>
          <textarea id="frame-note"></textarea>
          <a onclick="document.querySelector('#frame-result').textContent='Frame saved'">Enregistrer frame</a>
          <p id="frame-result">Waiting</p>`,
      });
    });
    await page.setContent(`<iframe name="admin-frame" src="${origin}/frame"></iframe>`);
    await page.frames()[1].waitForLoadState();
    const framed = workflow([
      step({
        id: "fill-frame",
        action: "fill",
        primary: 'role=textbox[name="Frame observation"]',
        role: "textbox",
        name: "Frame observation",
        value: "SYNTHETIC FRAME VALUE",
      }),
      step({
        id: "save-frame",
        action: "click",
        primary: 'role=link[name="Enregistrer frame"]',
        role: "button",
        name: "Enregistrer frame",
        postconditions: [
          {
            type: "text-visible",
            target: "Frame saved",
            expected: "Frame saved",
          },
        ],
      }),
    ]);
    framed.steps[1].target.role = "link";
    framed.steps[1].candidates.push({
      strategy: "role-name",
      selector: 'a:text-is("Enregistrer frame")',
      confidence: 0.9,
      unique: true,
      stability: 0.85,
      explanation: "Same-origin frame anchor fallback.",
      fallbackOrder: 1,
    });
    const planned = await inspectWorkflowOnExistingPage({
      page,
      workflow: framed,
      expectedOrigin: origin,
    });
    expect(
      planned.every((action) => action.locator.frame === "admin-frame"),
    ).toBe(true);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: framed,
      expectedOrigin: origin,
    });
    expect(telemetry.steps.map((result) => result.status)).toEqual([
      "passed",
      "passed",
    ]);
    expect(
      await page
        .frameLocator('iframe[name="admin-frame"]')
        .locator("#frame-result")
        .textContent(),
    ).toBe("Frame saved");
  });
});
