import { readFile } from "node:fs/promises";
import { chromium, type Locator, type Page } from "playwright";
import {
  SemanticWorkflowSchema,
  type SemanticStep,
  type SemanticWorkflow,
  type RuntimeTelemetry,
} from "@visual-compiler/semantic-ir";
import {
  clinicalPreflight,
  type ApplicationProfile,
  type PromotedWorkflow,
  type StructuralFingerprint,
} from "@visual-compiler/clinical-safety";

export type RuntimeOptions = {
  workflowPath: string;
  url: string;
  headless?: boolean;
  slowMo?: number;
  keepOpenMs?: number;
};

type RuntimeExecutionOptions = {
  headless?: boolean;
  slowMo?: number;
  keepOpenMs?: number;
};

export function isOpenAIHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "openai.com" || normalized.endsWith(".openai.com");
}

async function resolveSemanticLocator(
  page: Page,
  step: SemanticStep,
): Promise<Locator> {
  const locator = step.selectedLocator;
  if (!locator?.rule)
    throw new Error(`Step ${step.id} is missing a semantic locator rule.`);
  const rule = locator.rule;

  if (rule.candidateText && rule.candidateRole) {
    const direct = page.getByRole(rule.candidateRole, {
      name: rule.candidateText,
    });
    if ((await direct.count()) > 0) return direct.first();
  }

  if (!rule.anchorText || !rule.candidateRole) {
    throw new Error(`Step ${step.id} has insufficient locator data.`);
  }

  const anchor = page.getByText(rule.anchorText, { exact: true }).first();
  const anchorBox = await anchor.boundingBox();
  if (!anchorBox)
    throw new Error(`Anchor text not visible: ${rule.anchorText}`);

  const candidates = page.getByRole(rule.candidateRole);
  const matches: Array<{
    locator: Locator;
    box: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;
    distance: number;
  }> = [];
  const count = await candidates.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    if (rule.visibleOnly && !(await candidate.isVisible())) continue;
    if (rule.enabledOnly && !(await candidate.isEnabled())) continue;
    const box = await candidate.boundingBox();
    if (!box) continue;
    const centerY = box.y + box.height / 2;
    const anchorCenterY = anchorBox.y + anchorBox.height / 2;
    const centerX = box.x + box.width / 2;
    const anchorCenterX = anchorBox.x + anchorBox.width / 2;
    const sameRow = Math.abs(centerY - anchorCenterY) <= 24;
    const sameColumn = Math.abs(centerX - anchorCenterX) <= 34;
    const relationOk =
      (rule.relation === "right-of" &&
        box.x >= anchorBox.x + anchorBox.width - 4 &&
        sameRow) ||
      (rule.relation === "left-of" &&
        box.x + box.width <= anchorBox.x + 4 &&
        sameRow) ||
      (rule.relation === "below" &&
        box.y >= anchorBox.y + anchorBox.height - 4) ||
      (rule.relation === "above" && box.y + box.height <= anchorBox.y + 4) ||
      (rule.relation === "same-row" && sameRow) ||
      (rule.relation === "same-column" && sameColumn) ||
      rule.relation === "nearest";
    if (relationOk) {
      matches.push({
        locator: candidate,
        box,
        distance: Math.hypot(centerX - anchorCenterX, centerY - anchorCenterY),
      });
    }
  }
  if (matches.length === 0)
    throw new Error(`No runtime locator match for step ${step.id}.`);
  const ordered =
    rule.relation === "right-of"
      ? matches.sort((a, b) => a.box.x - b.box.x)
      : matches.sort((a, b) => a.distance - b.distance);
  const index = Math.max(0, (rule.ordinal ?? 1) - 1);
  return ordered[index]?.locator ?? ordered[0].locator;
}

async function runStep(page: Page, step: SemanticStep) {
  const target = await resolveSemanticLocator(page, step);
  if (step.action === "check") await target.check();
  else if (step.action === "uncheck") await target.uncheck();
  else if (step.action === "click") await target.click();
  else if (step.action === "fill") await target.fill(step.value ?? "");
  else if (step.action === "select")
    await target.selectOption(step.value ?? "");
  else if (step.action === "wait") await target.waitFor({ state: "visible" });
  else if (step.action === "assert") await target.waitFor({ state: "visible" });
  else throw new Error(`Unsupported runtime action: ${step.action}`);

  for (const assertion of step.postconditions) {
    if (assertion.type === "text-visible") {
      await page
        .getByText(String(assertion.expected ?? assertion.target), {
          exact: true,
        })
        .waitFor({ state: "visible" });
    }
    if (assertion.type === "checkbox-state") {
      const checked = await target.isChecked();
      if (checked !== assertion.expected)
        throw new Error(
          `Checkbox postcondition failed for ${assertion.target}.`,
        );
    }
  }
}

type FinalStateCheck = NonNullable<
  RuntimeTelemetry["finalState"]
>["checks"][number];

function stepTargetName(step: SemanticStep) {
  return (
    step.target.accessibleName ??
    step.selectedLocator?.rule?.candidateText ??
    step.selectedLocator?.primary ??
    step.intent
  );
}

function passedCheck(
  kind: FinalStateCheck["kind"],
  target: string,
  expected: string | boolean,
  actual: string | boolean,
): FinalStateCheck {
  if (actual !== expected) {
    throw new Error(
      `Final state failed for ${kind} "${target}": expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
  return { kind, target, expected, actual, passed: true };
}

async function verifyDerivedFinalState(page: Page, workflow: SemanticWorkflow) {
  const checks: FinalStateCheck[] = [];
  const statefulSteps = new Map<string, SemanticStep>();
  for (const step of workflow.steps) {
    if (["check", "uncheck", "fill", "select"].includes(step.action)) {
      statefulSteps.set(stepTargetName(step), step);
    }
  }

  for (const [targetName, step] of statefulSteps) {
    const target = await resolveSemanticLocator(page, step);
    if (step.action === "check" || step.action === "uncheck") {
      checks.push(
        passedCheck(
          "checkbox-state",
          targetName,
          step.action === "check",
          await target.isChecked(),
        ),
      );
    }
    if (step.action === "fill") {
      checks.push(
        passedCheck(
          "input-value",
          targetName,
          step.value ?? "",
          await target.inputValue(),
        ),
      );
    }
    if (step.action === "select") {
      checks.push(
        passedCheck(
          "select-value",
          targetName,
          step.value ?? "",
          await target.inputValue(),
        ),
      );
    }
  }

  for (const step of workflow.steps) {
    for (const assertion of step.postconditions) {
      if (assertion.type === "text-visible") {
        const expected = String(assertion.expected ?? assertion.target);
        checks.push(
          passedCheck(
            "text-visible",
            assertion.target,
            true,
            await page
              .getByText(expected, { exact: true })
              .first()
              .isVisible()
              .catch(() => false),
          ),
        );
      }
      if (assertion.type === "checkbox-state") {
        const target = await resolveSemanticLocator(page, step);
        checks.push(
          passedCheck(
            "checkbox-state",
            assertion.target,
            Boolean(assertion.expected),
            await target.isChecked(),
          ),
        );
      }
      if (assertion.type === "element-visible") {
        const target = await resolveSemanticLocator(page, step);
        checks.push(
          passedCheck(
            "element-visible",
            assertion.target,
            Boolean(assertion.expected ?? true),
            await target.isVisible(),
          ),
        );
      }
      if (assertion.type === "element-enabled") {
        const target = await resolveSemanticLocator(page, step);
        checks.push(
          passedCheck(
            "element-enabled",
            assertion.target,
            Boolean(assertion.expected ?? true),
            await target.isEnabled(),
          ),
        );
      }
    }
  }
  return { checks };
}

export async function runWorkflowObject(
  workflow: SemanticWorkflow,
  url: string,
  options: RuntimeExecutionOptions = {},
): Promise<RuntimeTelemetry> {
  const headless = options.headless ?? true;
  const keepOpenMs = Math.max(0, options.keepOpenMs ?? 0);
  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : Math.max(0, options.slowMo ?? 0),
  });
  const page = await browser.newPage({
    viewport: workflow.source.viewport,
    serviceWorkers: "block",
  });
  let blockedOpenAIRequests = 0;
  await page.route("**/*", async (route) => {
    const hostname = new URL(route.request().url()).hostname.toLowerCase();
    if (isOpenAIHostname(hostname)) {
      blockedOpenAIRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.routeWebSocket(
    (candidateUrl) => {
      const hostname = candidateUrl.hostname.toLowerCase();
      return isOpenAIHostname(hostname);
    },
    async (webSocket) => {
      blockedOpenAIRequests += 1;
      await webSocket.close({
        code: 1008,
        reason: "OpenAI network access is disabled at runtime.",
      });
    },
  );
  const telemetry: RuntimeTelemetry = {
    startedAt: new Date().toISOString(),
    llmCalls: 0,
    openAIRequests: 0,
    steps: [],
  };
  const started = Date.now();
  try {
    await page.goto(url);
    for (const step of workflow.steps) {
      const stepStart = Date.now();
      try {
        await runStep(page, step);
        telemetry.steps.push({
          stepId: step.id,
          action: step.action,
          status: "passed",
          durationMs: Date.now() - stepStart,
        });
      } catch (error) {
        telemetry.steps.push({
          stepId: step.id,
          action: step.action,
          status: "failed",
          durationMs: Date.now() - stepStart,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    telemetry.finalState = await verifyDerivedFinalState(page, workflow);
    if (!headless && keepOpenMs > 0) {
      await page.waitForTimeout(keepOpenMs);
    }
  } finally {
    await browser.close();
  }
  telemetry.finishedAt = new Date().toISOString();
  telemetry.durationMs = Date.now() - started;
  if (blockedOpenAIRequests !== 0) {
    throw new Error(
      `Runtime blocked ${blockedOpenAIRequests} attempted OpenAI network request(s).`,
    );
  }
  return telemetry;
}

export async function runCompiledWorkflow(options: RuntimeOptions) {
  const raw = await readFile(options.workflowPath, "utf8");
  const workflow = SemanticWorkflowSchema.parse(JSON.parse(raw));
  return runWorkflowObject(workflow, options.url, {
    headless: options.headless,
    slowMo: options.slowMo,
    keepOpenMs: options.keepOpenMs,
  });
}

export async function runPromotedWorkflowObject(input: {
  workflow: SemanticWorkflow;
  promotion: PromotedWorkflow;
  profile: ApplicationProfile;
  url: string;
  actualFingerprint: StructuralFingerprint;
  targetsUnique: boolean;
  preconditionsPassed: boolean;
  humanConfirmed: boolean;
  options?: RuntimeExecutionOptions;
}) {
  if (
    input.workflow.id !== input.promotion.workflowId ||
    input.workflow.version !== input.promotion.workflowVersion
  ) {
    throw new Error("Promoted metadata does not match the workflow identity.");
  }
  const preflight = clinicalPreflight({
    workflow: input.promotion,
    profile: input.profile,
    url: input.url,
    actualFingerprint: input.actualFingerprint,
    targetsUnique: input.targetsUnique,
    preconditionsPassed: input.preconditionsPassed,
    humanConfirmed: input.humanConfirmed,
  });
  if (!preflight.allowed) {
    throw new Error(
      `Clinical preflight failed: ${preflight.failures.join(", ")}.`,
    );
  }
  const telemetry = await runWorkflowObject(
    input.workflow,
    input.url,
    input.options,
  );
  return { preflight, telemetry };
}

export * from "./compatibilityProbe.js";
