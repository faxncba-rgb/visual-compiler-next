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
    ).rejects.toThrow(/matched 2 eligible elements/);
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
});
