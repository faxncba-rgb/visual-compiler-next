import { expect, test } from "@playwright/test";
import { runWorkflowOnExistingPage } from "@visual-compiler/runtime";
import { SemanticWorkflowSchema } from "@visual-compiler/semantic-ir";

const origin = "http://127.0.0.1:4273";

test("Lab runtime skips a readonly primary and fills the unique section-matched editable textarea", async ({
  page,
}) => {
  await page.goto(
    `${origin}/cgi-professional?readonly=1&patient_id=FAKE-READONLY&mytime=123`,
  );
  const workflow = SemanticWorkflowSchema.parse({
    id: "synthetic-readonly-lab-runtime",
    version: "0.1.0",
    name: "Dans la zone « Compte rendu administratif », écrire une note puis cliquer sur « Enregistrer »",
    source: {
      url: `${origin}/cgi-professional`,
      viewport: { width: 1280, height: 720 },
    },
    steps: [
      {
        id: "fill-administrative-note",
        action: "fill",
        intent: "Fill the synthetic administrative note",
        target: {
          role: "textbox",
          state: "enabled",
          relations: [],
        },
        value: "SYNTHETIC READONLY FALLBACK E2E",
        preconditions: [
          {
            type: "element-visible",
            target: "administrative note",
            expected: true,
          },
          {
            type: "element-enabled",
            target: "administrative note",
            expected: true,
          },
        ],
        postconditions: [
          {
            type: "text-visible",
            target: "SYNTHETIC READONLY FALLBACK E2E",
            expected: "SYNTHETIC READONLY FALLBACK E2E",
          },
        ],
        candidates: [
          {
            strategy: "relative-dom",
            selector: "role=textbox >> nth=0",
            confidence: 0.8,
            unique: true,
            stability: 0.8,
            explanation: "Synthetic ordinal reproducing the readonly failure.",
            fallbackOrder: 0,
          },
        ],
        selectedLocator: {
          kind: "semantic-rule",
          primary: "role=textbox >> nth=0",
          rule: {
            candidateRole: "textbox",
            ordinal: 1,
            visibleOnly: true,
            enabledOnly: true,
          },
          confidence: 0.8,
          explanation: "Synthetic readonly primary.",
        },
      },
      {
        id: "save-administrative-note",
        action: "click",
        intent: "Save the synthetic administrative note",
        target: {
          role: "button",
          accessibleName: "Enregistrer",
          state: "enabled",
          relations: [],
        },
        preconditions: [
          {
            type: "element-visible",
            target: "Enregistrer",
            expected: true,
          },
          {
            type: "element-enabled",
            target: "Enregistrer",
            expected: true,
          },
        ],
        postconditions: [
          {
            type: "text-visible",
            target: "Enregistrement synthétique effectué",
            expected: "Enregistrement synthétique effectué",
          },
        ],
        candidates: [
          {
            strategy: "role-name",
            selector: 'role=button[name="Enregistrer"]',
            confidence: 0.9,
            unique: false,
            stability: 0.9,
            explanation: "Disambiguated by the prior field container.",
            fallbackOrder: 0,
          },
        ],
        selectedLocator: {
          kind: "semantic-rule",
          primary: 'role=button[name="Enregistrer"]',
          rule: {
            candidateRole: "button",
            candidateText: "Enregistrer",
            ordinal: 1,
            visibleOnly: true,
            enabledOnly: true,
          },
          confidence: 0.9,
          explanation: "Synthetic save control.",
        },
      },
    ],
    generatedPlaywright: "// synthetic E2E workflow",
    compiledAt: "2026-07-26T00:00:00.000Z",
    compileModel: "mock",
    metadata: {
      compilerVersion: "0.2.0",
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

  const telemetry = await runWorkflowOnExistingPage({
    page,
    workflow,
    expectedOrigin: origin,
    labMode: true,
  });

  await expect(page.locator("#readonly-summary")).toHaveValue(
    "RÉSUMÉ-SYNTHÉTIQUE-LECTURE-SEULE",
  );
  await expect(page.locator("#observation")).toHaveValue(
    "SYNTHETIC READONLY FALLBACK E2E",
  );
  await expect(page.locator("#observation-result")).toHaveText(
    "Enregistrement synthétique effectué",
  );
  expect(telemetry.steps[0]).toMatchObject({
    status: "passed",
    locatorUsed: "editable-semantic-fallback",
    primaryEditableCount: 0,
    fillStrategy: "playwright-fill",
    postconditionNormalized: "input-value",
  });
  expect(telemetry.steps[0].readOnlyCount).toBe(1);
  expect(telemetry.steps[0].editableCount).toBeGreaterThanOrEqual(2);
  expect(telemetry.steps[1]).toMatchObject({
    status: "passed",
    fallbackSelected: true,
  });
  expect(telemetry.llmCalls).toBe(0);
  expect(telemetry.openAIRequests).toBe(0);
  expect(JSON.stringify(telemetry)).not.toContain(
    "SYNTHETIC READONLY FALLBACK E2E",
  );
  expect(JSON.stringify(telemetry)).not.toContain("patient_id");
  expect(JSON.stringify(telemetry)).not.toContain("mytime");
});
