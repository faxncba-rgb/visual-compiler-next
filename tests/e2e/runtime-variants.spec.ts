import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  compileWorkflow,
  mockInterpretInstruction,
} from "@visual-compiler/compiler";
import {
  runCompiledWorkflow,
  runWorkflowObject,
} from "@visual-compiler/runtime";
import { SemanticWorkflowSchema } from "@visual-compiler/semantic-ir";
import { DEFAULT_INSTRUCTION, WORKFLOW_PATH } from "@visual-compiler/shared";

const demoOrigin = process.env.E2E_DEMO_ORIGIN ?? "http://127.0.0.1:4273";

async function sha256(filePath: string) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

test("compiled workflow replays on variants A and B with zero runtime LLM calls", async ({}, testInfo) => {
  const workflowPath = testInfo.outputPath("pending-review.workflow.json");
  await compileWorkflow({
    instruction: DEFAULT_INSTRUCTION,
    url: `${demoOrigin}/demo?variant=A`,
    outPath: workflowPath,
    headless: true,
  });
  delete process.env.OPENAI_API_KEY;
  for (const variant of ["A", "B"] as const) {
    const telemetry = await runCompiledWorkflow({
      workflowPath,
      url: `${demoOrigin}/demo?variant=${variant}`,
      headless: true,
    });
    expect(telemetry.llmCalls).toBe(0);
    expect(telemetry.openAIRequests).toBe(0);
    expect(telemetry.steps.every((step) => step.status === "passed")).toBe(
      true,
    );
  }
});

test("tracked GPT-5.6 artifact replays on variants A and B without OpenAI", async () => {
  delete process.env.OPENAI_API_KEY;
  for (const variant of ["A", "B"] as const) {
    const telemetry = await runCompiledWorkflow({
      workflowPath: WORKFLOW_PATH,
      url: `${demoOrigin}/demo?variant=${variant}`,
      headless: true,
    });
    expect(telemetry.llmCalls).toBe(0);
    expect(telemetry.openAIRequests).toBe(0);
    expect(telemetry.steps).toHaveLength(2);
    expect(telemetry.steps.every((step) => step.status === "passed")).toBe(
      true,
    );
    expect(telemetry.finalState?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "checkbox-state",
          actual: true,
          passed: true,
        }),
      ]),
    );
  }
});

test("two instructions create distinct versioned artifacts without replacing the validated artifact", async ({}, testInfo) => {
  const before = await sha256(WORKFLOW_PATH);
  const outDir = testInfo.outputPath("versioned-workflows");
  const fixtureInterpreter = async () => ({
    result: mockInterpretInstruction(DEFAULT_INSTRUCTION),
    responseModel: undefined,
    tokenUsage: undefined,
    source: "mock" as const,
    modelCalls: 0,
  });
  const first = await compileWorkflow({
    instruction: DEFAULT_INSTRUCTION,
    url: `${demoOrigin}/demo?variant=A`,
    outDir,
    headless: true,
    interpreter: fixtureInterpreter,
  });
  const second = await compileWorkflow({
    instruction:
      "Check the Invoice packet primary checkbox, then click Confirm selection.",
    url: `${demoOrigin}/demo?variant=A`,
    outDir,
    headless: true,
    interpreter: fixtureInterpreter,
  });

  expect(first.id).not.toBe(second.id);
  expect(first.id).toMatch(/-[0-9a-f]{8}$/);
  expect(second.id).toMatch(/-[0-9a-f]{8}$/);
  expect(first.name).not.toBe(second.name);
  expect((await readdir(outDir)).sort()).toEqual(
    [`${first.id}.json`, `${second.id}.json`].sort(),
  );
  expect(await sha256(WORKFLOW_PATH)).toBe(before);
});

test("runtime executes select and derives its final-state evidence", async () => {
  const workflow = SemanticWorkflowSchema.parse({
    id: "select-workflow",
    version: "0.1.0",
    name: "Select priority",
    source: {
      url: "data:text/html,select",
      viewport: { width: 800, height: 600 },
    },
    steps: [
      {
        id: "select-priority",
        action: "select",
        intent: "Select high priority",
        target: {
          role: "combobox",
          accessibleName: "Priority",
          relations: [],
        },
        value: "high",
        preconditions: [],
        postconditions: [],
        candidates: [],
        selectedLocator: {
          kind: "semantic-rule",
          primary: 'role=combobox[name="Priority"]',
          rule: {
            candidateRole: "combobox",
            candidateText: "Priority",
            relation: "nearest",
            ordinal: 1,
            enabledOnly: true,
            visibleOnly: true,
          },
          confidence: 0.99,
          explanation: "Unique accessible combobox.",
        },
      },
    ],
    generatedPlaywright: "",
    compiledAt: new Date().toISOString(),
    compileModel: "none",
    metadata: {
      compilerVersion: "0.1.0",
      targetUrl: "data:text/html,select",
    },
    diagnostics: {
      modelCalls: 0,
      interpretationSource: "mock",
      warnings: [],
      durationMs: 0,
      rejected: false,
    },
  });
  const html = encodeURIComponent(
    '<label>Priority<select aria-label="Priority"><option value="low">Low</option><option value="high">High</option></select></label>',
  );
  const telemetry = await runWorkflowObject(
    workflow,
    `data:text/html,${html}`,
    { headless: true },
  );

  expect(telemetry.llmCalls).toBe(0);
  expect(telemetry.openAIRequests).toBe(0);
  expect(telemetry.finalState?.checks).toContainEqual({
    kind: "select-value",
    target: "Priority",
    expected: "high",
    actual: "high",
    passed: true,
  });
});
