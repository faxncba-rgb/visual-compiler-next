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
    await expect
      .poll(async () => page.locator("#result").textContent())
      .toBe("Saved");
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
      fallbackReason: "Primary unavailable — deterministic fallback selected.",
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
    await page.setContent(
      `<iframe name="admin-frame" src="${origin}/frame"></iframe>`,
    );
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

  test("rejects a readonly primary immediately and selects the unique semantic editable fallback", async () => {
    await page.setContent(`<!doctype html><main>
      <section><h2>Résumé administratif</h2>
        <textarea readonly>IMMUTABLE SYNTHETIC SUMMARY</textarea>
      </section>
      <section><h2>Saisie de la consultation</h2>
        <textarea id="consultation-note"></textarea>
        <button id="save-consultation">Enregistrer</button>
      </section>
      <section><h2>Note secondaire</h2><textarea></textarea></section>
      <script>
        document.querySelector('#save-consultation').addEventListener('click', () => {
          document.body.dataset.saved = 'once';
        });
      </script>
    </main>`);
    const selected = workflow([
      step({
        id: "fill-consultation",
        action: "fill",
        primary: "role=textbox >> nth=0",
        role: "textbox",
        value: "SYNTHETIC EDITABLE FALLBACK",
        postconditions: [
          {
            type: "text-visible",
            target: "SYNTHETIC EDITABLE FALLBACK",
            expected: "SYNTHETIC EDITABLE FALLBACK",
          },
        ],
      }),
      step({
        id: "save-consultation",
        action: "click",
        primary: 'role=button[name="Enregistrer"]',
        role: "button",
        name: "Enregistrer",
      }),
    ]);
    selected.name =
      "Dans la zone « Saisie de la consultation », écrire une note puis enregistrer";
    const started = Date.now();
    const planned = await inspectWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(planned[0].locator).toMatchObject({
      selectedLocator: "editable-semantic-fallback",
      strategy: "editable-semantic-fallback",
      fallbackReason:
        "Primary textbox unavailable — unique editable fallback selected.",
      primaryEditableCount: 0,
      readOnlyCount: 1,
      editableCount: 2,
      isEditable: true,
      readOnly: false,
    });

    const progress: string[] = [];
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
      labMode: true,
      onProgress: ({ label }) => {
        progress.push(label);
      },
    });
    expect(await page.locator("#consultation-note").inputValue()).toBe(
      "SYNTHETIC EDITABLE FALLBACK",
    );
    expect(await page.locator("textarea").first().inputValue()).toBe(
      "IMMUTABLE SYNTHETIC SUMMARY",
    );
    expect(await page.locator("body").getAttribute("data-saved")).toBe("once");
    expect(telemetry.steps[0]).toMatchObject({
      status: "passed",
      fillStrategy: "playwright-fill",
      postconditionNormalized: "input-value",
    });
    expect(telemetry.steps[0].phases.map((item) => item.phase)).toEqual([
      "locator-resolution",
      "precondition",
      "actionability",
      "action",
      "postcondition",
    ]);
    expect(progress).toContain("Checking editability");
    expect(progress).toContain("Filling field");
    expect(progress).toContain("Verifying entered value");
    expect(progress).toContain("Resolving Enregistrer");
    expect(progress).toContain("Clicking Enregistrer");
    expect(JSON.stringify(telemetry)).not.toContain(
      "SYNTHETIC EDITABLE FALLBACK",
    );
  });

  test("fills a contenteditable target and normalizes a text-visible fill postcondition", async () => {
    await page.setContent(`<main>
      <label id="editor-label">Saisie de la consultation</label>
      <div id="editor" role="textbox" aria-labelledby="editor-label" contenteditable="true"></div>
    </main>`);
    const selected = workflow([
      step({
        id: "fill-editor",
        action: "fill",
        primary: 'role=textbox[name="Saisie de la consultation"]',
        role: "textbox",
        name: "Saisie de la consultation",
        value: "SYNTHETIC CONTENTEDITABLE",
        postconditions: [
          {
            type: "text-visible",
            target: "SYNTHETIC CONTENTEDITABLE",
            expected: "SYNTHETIC CONTENTEDITABLE",
          },
        ],
      }),
    ]);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
      labMode: true,
    });
    expect(await page.locator("#editor").textContent()).toBe(
      "SYNTHETIC CONTENTEDITABLE",
    );
    expect(telemetry.steps[0]).toMatchObject({
      status: "passed",
      contentEditable: true,
      fillStrategy: "contenteditable-fill",
      postconditionNormalized: "input-value",
    });
  });

  test("fills contenteditable in a same-origin frame without inspecting cross-origin frames", async () => {
    await page.context().route(`${origin}/editable-frame`, async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<label id="frame-editor-label">Frame editor</label>
          <div id="frame-editor" role="textbox" aria-labelledby="frame-editor-label" contenteditable="true"></div>`,
      });
    });
    await page.setContent(
      `<iframe name="editable-frame" src="${origin}/editable-frame"></iframe>`,
    );
    await page.frames()[1].waitForLoadState();
    const selected = workflow([
      step({
        id: "fill-frame-editor",
        action: "fill",
        primary: 'role=textbox[name="Frame editor"]',
        role: "textbox",
        name: "Frame editor",
        value: "SYNTHETIC FRAME EDITOR",
      }),
    ]);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
      labMode: true,
    });
    expect(telemetry.steps[0]).toMatchObject({
      status: "passed",
      frame: "editable-frame",
      contentEditable: true,
      fillStrategy: "contenteditable-fill",
    });
    expect(
      await page
        .frameLocator('iframe[name="editable-frame"]')
        .locator("#frame-editor")
        .textContent(),
    ).toBe("SYNTHETIC FRAME EDITOR");
  });

  test("uses keyboard input only after standard fill verification fails", async () => {
    await page.setContent(`<main>
      <label for="keyboard-note">Keyboard note</label>
      <textarea id="keyboard-note"></textarea>
      <script>
        let resetOnce = true;
        document.querySelector('#keyboard-note').addEventListener('input', event => {
          if (resetOnce) {
            resetOnce = false;
            event.currentTarget.value = '';
          }
        });
      </script>
    </main>`);
    const selected = workflow([
      step({
        id: "keyboard-fill",
        action: "fill",
        primary: 'role=textbox[name="Keyboard note"]',
        role: "textbox",
        name: "Keyboard note",
        value: "SYNTHETIC KEYBOARD VALUE",
      }),
    ]);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
      labMode: true,
    });
    expect(await page.locator("#keyboard-note").inputValue()).toBe(
      "SYNTHETIC KEYBOARD VALUE",
    );
    expect(telemetry.steps[0]).toMatchObject({
      status: "passed",
      fillStrategy: "keyboard-input",
      fillAttempts: [
        {
          strategy: "playwright-fill",
          status: "failed",
          errorRedacted: "Entered value verification failed.",
        },
        { strategy: "keyboard-input", status: "passed" },
      ],
    });
  });

  test("uses the native value setter only in Lab mode after DOM fill strategies fail", async () => {
    await page.setContent(`<main>
      <label for="native-note">Native note</label>
      <textarea id="native-note"></textarea>
      <script>
        document.querySelector('#native-note').addEventListener('input', event => {
          if (event instanceof InputEvent) event.currentTarget.value = '';
        });
      </script>
    </main>`);
    const selected = workflow([
      step({
        id: "native-fill",
        action: "fill",
        primary: 'role=textbox[name="Native note"]',
        role: "textbox",
        name: "Native note",
        value: "SYNTHETIC NATIVE VALUE",
      }),
    ]);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
      labMode: true,
    });
    expect(await page.locator("#native-note").inputValue()).toBe(
      "SYNTHETIC NATIVE VALUE",
    );
    expect(telemetry.steps[0]).toMatchObject({
      status: "passed",
      fillStrategy: "native-value-setter",
      fillAttempts: [
        { strategy: "playwright-fill", status: "failed" },
        { strategy: "keyboard-input", status: "failed" },
        { strategy: "native-value-setter", status: "passed" },
      ],
    });
    await page.locator("#native-note").evaluate((element) => {
      (element as HTMLTextAreaElement).value = "";
    });
    const outsideLab = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
      labMode: false,
    });
    expect(outsideLab.steps[0]).toMatchObject({
      status: "failed",
      failedPhase: "action",
      errorRedacted: "Entered value verification failed.",
    });
    expect(outsideLab.steps[0].fillAttempts).toHaveLength(2);
    expect(
      outsideLab.steps[0].fillAttempts?.map((item) => item.strategy),
    ).toEqual(["playwright-fill", "keyboard-input"]);
  });

  test("fails closed on ambiguous editable fallbacks and never clicks save", async () => {
    await page.setContent(`<main>
      <textarea readonly></textarea>
      <section><h2>Saisie de la consultation</h2><textarea></textarea></section>
      <section><h2>Saisie de la consultation</h2><textarea></textarea></section>
      <button onclick="document.body.dataset.saved='yes'">Enregistrer</button>
    </main>`);
    const selected = workflow([
      step({
        id: "ambiguous-fill",
        action: "fill",
        primary: "role=textbox >> nth=0",
        role: "textbox",
        value: "MUST REMAIN REDACTED",
      }),
      step({
        id: "must-not-save",
        action: "click",
        primary: 'role=button[name="Enregistrer"]',
        role: "button",
        name: "Enregistrer",
      }),
    ]);
    selected.name = "Écrire dans « Saisie de la consultation »";
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
      labMode: true,
    });
    expect(telemetry.steps).toHaveLength(1);
    expect(telemetry.steps[0]).toMatchObject({
      status: "failed",
      failedPhase: "locator-resolution",
      errorRedacted: "No unique editable target was found.",
    });
    expect(await page.locator("body").getAttribute("data-saved")).toBeNull();
    expect(JSON.stringify(telemetry)).not.toContain("MUST REMAIN REDACTED");
  });

  test("stops during the action phase and does not execute a later save", async () => {
    const controller = new AbortController();
    const selected = workflow([
      step({
        id: "stop-during-fill",
        action: "fill",
        primary: "role=textbox >> nth=0",
        role: "textbox",
        value: "MUST NOT BE WRITTEN",
      }),
      step({
        id: "must-not-save-after-stop",
        action: "click",
        primary: "role=button >> nth=0",
        role: "button",
      }),
    ]);
    const telemetry = await runWorkflowOnExistingPage({
      page,
      workflow: selected,
      expectedOrigin: origin,
      labMode: true,
      signal: controller.signal,
      onProgress: ({ phase }) => {
        if (phase === "action") controller.abort();
      },
    });
    expect(telemetry.steps).toHaveLength(1);
    expect(telemetry.steps[0]).toMatchObject({
      status: "failed",
      failedPhase: "action",
      errorRedacted: "Execution stopped by operator.",
    });
    expect(await page.getByRole("textbox").inputValue()).toBe("");
    expect(await page.locator("#result").textContent()).toBe("Pending");
  });
});
