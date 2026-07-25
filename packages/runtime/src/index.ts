import { readFile } from "node:fs/promises";
import {
  chromium,
  type Locator,
  type Page,
} from "playwright";
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

export type ExistingPageLocatorEvidence = {
  stepId: string;
  selectedLocator: string;
  strategy: "role-name" | "role-ordinal" | "text" | "semantic-rule";
  matchCount: number;
  unique: true;
};

export type ExistingPagePlannedAction = {
  stepId: string;
  action: SemanticStep["action"];
  target: string;
  selectedLocator: string;
  value?: string;
  locator: ExistingPageLocatorEvidence;
  preconditionsPassed: true;
};

export type ExistingPageTelemetry = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  llmCalls: 0;
  openAIRequests: 0;
  steps: Array<{
    stepId: string;
    action: SemanticStep["action"];
    status: "passed" | "failed";
    durationMs: number;
  }>;
};

type ResolvedExistingPageLocator = {
  locator: Locator;
  evidence: ExistingPageLocatorEvidence;
};
type PlaywrightAriaRole = Parameters<Page["getByRole"]>[0];

function selectedLocatorLabel(step: SemanticStep) {
  return (
    step.target.accessibleName ??
    step.selectedLocator?.rule?.candidateText ??
    step.selectedLocator?.primary ??
    step.intent
  );
}

async function filterEligibleLocators(
  candidates: Locator,
  visibleOnly: boolean,
  enabledOnly: boolean,
) {
  const eligible: number[] = [];
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if (visibleOnly && !(await candidate.isVisible())) continue;
    if (enabledOnly && !(await candidate.isEnabled())) continue;
    eligible.push(index);
  }
  return eligible;
}

async function resolveSelectedLocator(
  page: Page,
  step: SemanticStep,
): Promise<ResolvedExistingPageLocator> {
  const selected = step.selectedLocator;
  if (!selected) {
    throw new Error(`Step ${step.id} has no selected locator.`);
  }
  const visibleOnly = selected.rule?.visibleOnly ?? true;
  const enabledOnly = selected.rule?.enabledOnly ?? true;
  const roleName = selected.primary.match(
    /^role=([a-z]+)\[name=(?:"([^"]+)"|'([^']+)')\]$/,
  );
  if (roleName) {
    const role = roleName[1] as PlaywrightAriaRole;
    const name = roleName[2] ?? roleName[3] ?? "";
    const candidates = page.getByRole(role, { name, exact: true });
    const eligible = await filterEligibleLocators(
      candidates,
      visibleOnly,
      enabledOnly,
    );
    if (eligible.length !== 1) {
      throw new Error(
        `Step ${step.id} selected role/name locator matched ${eligible.length} eligible elements.`,
      );
    }
    return {
      locator: candidates.nth(eligible[0]),
      evidence: {
        stepId: step.id,
        selectedLocator: selected.primary,
        strategy: "role-name",
        matchCount: 1,
        unique: true,
      },
    };
  }

  const roleOrdinal = selected.primary.match(
    /^role=([a-z]+)\s*>>\s*nth=(\d+)$/,
  );
  if (roleOrdinal) {
    const role = roleOrdinal[1] as PlaywrightAriaRole;
    const ordinal = Number.parseInt(roleOrdinal[2], 10);
    const candidates = page.getByRole(role);
    const eligible = await filterEligibleLocators(
      candidates,
      visibleOnly,
      enabledOnly,
    );
    if (ordinal < 0 || ordinal >= eligible.length) {
      throw new Error(
        `Step ${step.id} selected ordinal ${ordinal} is outside ${eligible.length} eligible ${role} elements.`,
      );
    }
    return {
      locator: candidates.nth(eligible[ordinal]),
      evidence: {
        stepId: step.id,
        selectedLocator: selected.primary,
        strategy: "role-ordinal",
        matchCount: eligible.length,
        unique: true,
      },
    };
  }

  const textSelector = selected.primary.match(
    /^([a-z][a-z0-9-]*):text-is\((?:"([^"]+)"|'([^']+)')\)$/,
  );
  if (textSelector) {
    const tagName = textSelector[1];
    const text = textSelector[2] ?? textSelector[3] ?? "";
    const candidates = page.locator(tagName).filter({ hasText: text });
    const eligible = await filterEligibleLocators(
      candidates,
      visibleOnly,
      enabledOnly,
    );
    if (eligible.length !== 1) {
      throw new Error(
        `Step ${step.id} selected text locator matched ${eligible.length} eligible elements.`,
      );
    }
    return {
      locator: candidates.nth(eligible[0]),
      evidence: {
        stepId: step.id,
        selectedLocator: selected.primary,
        strategy: "text",
        matchCount: 1,
        unique: true,
      },
    };
  }

  const locator = await resolveSemanticLocator(page, step);
  if ((await locator.count()) !== 1) {
    throw new Error(`Step ${step.id} semantic locator is not unique.`);
  }
  return {
    locator,
    evidence: {
      stepId: step.id,
      selectedLocator: selected.primary,
      strategy: "semantic-rule",
      matchCount: 1,
      unique: true,
    },
  };
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
    if ((await direct.count()) === 1) return direct;
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

async function verifyStepAssertions(
  page: Page,
  target: Locator,
  assertions: SemanticStep["preconditions"],
) {
  for (const assertion of assertions) {
    if (assertion.type === "text-visible") {
      const expected = String(assertion.expected ?? assertion.target);
      if (
        !(await page
          .getByText(expected, { exact: true })
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        throw new Error("A required text precondition is not visible.");
      }
    } else if (assertion.type === "checkbox-state") {
      if (
        (await target.isChecked().catch(() => false)) !==
        Boolean(assertion.expected)
      ) {
        throw new Error("A required checkbox precondition failed.");
      }
    } else if (assertion.type === "element-visible") {
      if ((await target.isVisible()) !== Boolean(assertion.expected ?? true)) {
        throw new Error("A required visibility precondition failed.");
      }
    } else if (assertion.type === "element-enabled") {
      if ((await target.isEnabled()) !== Boolean(assertion.expected ?? true)) {
        throw new Error("A required enabled-state precondition failed.");
      }
    }
  }
}

async function verifyStepPostconditions(
  page: Page,
  target: Locator,
  step: SemanticStep,
) {
  await verifyStepAssertions(page, target, step.postconditions);
}

async function runStepWithTarget(
  page: Page,
  step: SemanticStep,
  target: Locator,
) {
  if (step.action === "check") await target.check();
  else if (step.action === "uncheck") await target.uncheck();
  else if (step.action === "click") await target.click();
  else if (step.action === "fill") await target.fill(step.value ?? "");
  else if (step.action === "select")
    await target.selectOption(step.value ?? "");
  else if (step.action === "wait") await target.waitFor({ state: "visible" });
  else if (step.action === "assert") await target.waitFor({ state: "visible" });
  else throw new Error(`Unsupported runtime action: ${step.action}`);

  await verifyStepPostconditions(page, target, step);
}

async function runStep(page: Page, step: SemanticStep) {
  const target = await resolveSemanticLocator(page, step);
  await runStepWithTarget(page, step, target);
}

function assertPageOrigin(page: Page, expectedOrigin: string) {
  const current = new URL(page.url());
  if (current.origin !== expectedOrigin) {
    throw new Error("The managed page left its locked application origin.");
  }
}

export async function inspectWorkflowOnExistingPage(input: {
  page: Page;
  workflow: SemanticWorkflow;
  expectedOrigin: string;
}): Promise<ExistingPagePlannedAction[]> {
  assertPageOrigin(input.page, input.expectedOrigin);
  const plannedActions: ExistingPagePlannedAction[] = [];
  for (const step of input.workflow.steps) {
    const resolved = await resolveSelectedLocator(input.page, step);
    await verifyStepAssertions(
      input.page,
      resolved.locator,
      step.preconditions,
    );
    plannedActions.push({
      stepId: step.id,
      action: step.action,
      target: selectedLocatorLabel(step),
      selectedLocator: resolved.evidence.selectedLocator,
      ...(step.value !== undefined ? { value: step.value } : {}),
      locator: resolved.evidence,
      preconditionsPassed: true,
    });
  }
  return plannedActions;
}

export async function runWorkflowOnExistingPage(input: {
  page: Page;
  workflow: SemanticWorkflow;
  expectedOrigin: string;
}): Promise<ExistingPageTelemetry> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const steps: ExistingPageTelemetry["steps"] = [];
  await input.page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (isOpenAIHostname(requestUrl.hostname)) {
      await route.abort("blockedbyclient");
      return;
    }
    const isMainNavigation =
      route.request().isNavigationRequest() &&
      route.request().frame() === input.page.mainFrame();
    if (isMainNavigation && requestUrl.origin !== input.expectedOrigin) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
  await input.page.routeWebSocket(
    (url) => isOpenAIHostname(url.hostname),
    (webSocket) =>
      webSocket.close({
        code: 1008,
        reason: "OpenAI network access is forbidden at runtime.",
      }),
  );
  assertPageOrigin(input.page, input.expectedOrigin);
  for (const step of input.workflow.steps) {
    const stepStarted = Date.now();
    try {
      const resolved = await resolveSelectedLocator(input.page, step);
      await verifyStepAssertions(
        input.page,
        resolved.locator,
        step.preconditions,
      );
      await runStepWithTarget(input.page, step, resolved.locator);
      assertPageOrigin(input.page, input.expectedOrigin);
      steps.push({
        stepId: step.id,
        action: step.action,
        status: "passed",
        durationMs: Date.now() - stepStarted,
      });
    } catch {
      steps.push({
        stepId: step.id,
        action: step.action,
        status: "failed",
        durationMs: Date.now() - stepStarted,
      });
      break;
    }
  }
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    llmCalls: 0,
    openAIRequests: 0,
    steps,
  };
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
