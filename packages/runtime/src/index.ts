import { readFile } from "node:fs/promises";
import {
  chromium,
  type Frame,
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
  primaryLocator: string;
  selectedLocator: string;
  fallbackSelected: boolean;
  fallbackReason?: string;
  strategy: string;
  matchCount: number;
  visibleCount: number;
  enabledCount: number;
  frame: string;
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
    primaryLocator: string;
    locatorUsed?: string;
    fallbackSelected?: boolean;
    fallbackReason?: string;
    matchCount?: number;
    visibleCount?: number;
    enabledCount?: number;
    frame?: string;
    errorRedacted?: string;
  }>;
};

type ResolvedExistingPageLocator = {
  locator: Locator;
  evidence: ExistingPageLocatorEvidence;
};
type PlaywrightAriaRole = Parameters<Page["getByRole"]>[0];
type LocatorScope = Frame;

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

function sameOriginScopes(page: Page, expectedOrigin: string) {
  return page
    .frames()
    .filter((frame) => {
      try {
        return new URL(frame.url()).origin === expectedOrigin;
      } catch {
        return false;
      }
    })
    .map((frame, index) => {
      const frameUrl = new URL(frame.url());
      return {
        scope: frame,
        id:
          frame === page.mainFrame()
            ? "main"
            : frame.name() ||
              frameUrl.pathname ||
              `same-origin-frame-${index}`,
      };
    });
}

function selectorLocator(
  scope: LocatorScope | Locator,
  selector: string,
): { locator: Locator; strategy: string } | null {
  const roleName = selector.match(
    /^role=([a-z]+)\[name=(?:"([^"]+)"|'([^']+)')\]$/,
  );
  if (roleName && "getByRole" in scope) {
    return {
      locator: scope.getByRole(roleName[1] as PlaywrightAriaRole, {
        name: roleName[2] ?? roleName[3] ?? "",
        exact: true,
      }),
      strategy: "role-name",
    };
  }
  const roleOrdinal = selector.match(/^role=([a-z]+)\s*>>\s*nth=(\d+)$/);
  if (roleOrdinal && "getByRole" in scope) {
    return {
      locator: scope
        .getByRole(roleOrdinal[1] as PlaywrightAriaRole)
        .nth(Number.parseInt(roleOrdinal[2], 10)),
      strategy: "role-ordinal",
    };
  }
  const label = selector.match(/^label=(?:"([^"]+)"|'([^']+)')$/);
  if (label && "getByLabel" in scope) {
    return {
      locator: scope.getByLabel(label[1] ?? label[2] ?? "", { exact: true }),
      strategy: "label",
    };
  }
  const textSelector = selector.match(
    /^([a-z][a-z0-9-]*):text-is\((?:"([^"]+)"|'([^']+)')\)$/,
  );
  if (textSelector) {
    return {
      locator: scope
        .locator(textSelector[1])
        .filter({ hasText: textSelector[2] ?? textSelector[3] ?? "" }),
      strategy:
        textSelector[1] === "a" ? "anchor-text" : "element-text",
    };
  }
  const elementOrdinal = selector.match(
    /^([a-z][a-z0-9-]*)\s*>>\s*nth=(\d+)$/,
  );
  if (elementOrdinal) {
    return {
      locator: scope
        .locator(elementOrdinal[1])
        .nth(Number.parseInt(elementOrdinal[2], 10)),
      strategy: "element-ordinal",
    };
  }
  if (selector.startsWith("text-exact=")) {
    const text = selector.slice("text-exact=".length);
    return {
      locator: scope.getByText(text, { exact: true }),
      strategy: "exact-text",
    };
  }
  if (selector.startsWith("a-onclick:text-is=")) {
    const text = selector.slice("a-onclick:text-is=".length);
    return {
      locator: scope.locator("a:not([href])").filter({ hasText: text }),
      strategy: "onclick-anchor-text",
    };
  }
  if (selector.startsWith("input-submit:value=")) {
    const value = selector.slice("input-submit:value=".length);
    return {
      locator: scope.locator(
        `input[type=submit][value=${JSON.stringify(value)}]`,
      ),
      strategy: "submit-value",
    };
  }
  return null;
}

async function attemptSelector(
  page: Page,
  expectedOrigin: string,
  selector: string,
  visibleOnly: boolean,
  enabledOnly: boolean,
  scopedContainer?: Locator,
) {
  const scopes = scopedContainer
    ? [{ scope: scopedContainer, id: "previous-step-container" }]
    : sameOriginScopes(page, expectedOrigin);
  const eligibleMatches: Array<{ locator: Locator; frame: string }> = [];
  let matchCount = 0;
  let visibleCount = 0;
  let enabledCount = 0;
  let strategy = "unknown";
  for (const scopeEntry of scopes) {
    const resolved = selectorLocator(scopeEntry.scope, selector);
    if (!resolved) continue;
    strategy = resolved.strategy;
    const count = await resolved.locator.count();
    matchCount += count;
    for (let index = 0; index < count; index += 1) {
      const candidate = resolved.locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      const enabled = await candidate.isEnabled().catch(() => false);
      visibleCount += Number(visible);
      enabledCount += Number(visible && enabled);
      if ((!visibleOnly || visible) && (!enabledOnly || enabled)) {
        eligibleMatches.push({ locator: candidate, frame: scopeEntry.id });
      }
    }
  }
  return {
    selector,
    strategy,
    matchCount,
    visibleCount,
    enabledCount,
    eligibleMatches,
  };
}

async function resolveSelectedLocator(
  page: Page,
  step: SemanticStep,
  expectedOrigin: string,
  previous?: ResolvedExistingPageLocator,
): Promise<ResolvedExistingPageLocator> {
  const selected = step.selectedLocator;
  if (!selected) {
    throw new Error(`Step ${step.id} has no selected locator.`);
  }
  const visibleOnly = selected.rule?.visibleOnly ?? true;
  const enabledOnly = selected.rule?.enabledOnly ?? true;
  const artifactFallbacks = [
    ...step.candidates.map((candidate) => candidate.selector),
    ...(selected.fallback ? [selected.fallback] : []),
  ].filter((selector, index, all) => all.indexOf(selector) === index);
  const positionalSelector = (selector: string) =>
    /(?:^|\s>>\s)nth=\d+$/.test(selector);
  const semanticArtifactFallbacks = artifactFallbacks.filter(
    (selector) => !positionalSelector(selector),
  );
  const positionalArtifactFallbacks = artifactFallbacks.filter(
    positionalSelector,
  );
  const targetName =
    step.target.accessibleName ?? selected.rule?.candidateText;
  const synthesizedSemanticFallbacks: string[] = [];
  if (targetName) {
    synthesizedSemanticFallbacks.push(
      `role=button[name="${targetName.replaceAll('"', '\\"')}"]`,
      `text-exact=${targetName}`,
      `button:text-is("${targetName.replaceAll('"', '\\"')}")`,
      `input-submit:value=${targetName}`,
      `a-onclick:text-is=${targetName}`,
      `[role=button]:text-is("${targetName.replaceAll('"', '\\"')}")`,
    );
  }
  const semanticSelectors = [
    selected.primary,
    ...semanticArtifactFallbacks,
    ...synthesizedSemanticFallbacks,
  ].filter((selector, index, all) => all.indexOf(selector) === index);
  let primaryAttempt:
    | Awaited<ReturnType<typeof attemptSelector>>
    | undefined;
  for (const [index, selector] of semanticSelectors.entries()) {
    const attempt = await attemptSelector(
      page,
      expectedOrigin,
      selector,
      visibleOnly,
      enabledOnly,
    );
    if (index === 0) primaryAttempt = attempt;
    if (attempt.eligibleMatches.length === 1) {
      return {
        locator: attempt.eligibleMatches[0].locator,
        evidence: {
          stepId: step.id,
          primaryLocator: selected.primary,
          selectedLocator: selector,
          fallbackSelected: selector !== selected.primary,
          ...(selector !== selected.primary
            ? {
                fallbackReason:
                  "Primary unavailable — deterministic fallback selected.",
              }
            : {}),
          strategy: attempt.strategy,
          matchCount: attempt.matchCount,
          visibleCount: attempt.visibleCount,
          enabledCount: attempt.enabledCount,
          frame: attempt.eligibleMatches[0].frame,
          unique: true,
        },
      };
    }
  }
  if (targetName && previous) {
    const container = previous.locator.locator(
      "xpath=ancestor::*[self::section or self::form or self::fieldset or self::article][1]",
    );
    if ((await container.count()) === 1) {
      for (const selector of [
        `text-exact=${targetName}`,
        `a-onclick:text-is=${targetName}`,
      ]) {
        const attempt = await attemptSelector(
          page,
          expectedOrigin,
          selector,
          visibleOnly,
          enabledOnly,
          container,
        );
        if (attempt.eligibleMatches.length === 1) {
          return {
            locator: attempt.eligibleMatches[0].locator,
            evidence: {
              stepId: step.id,
              primaryLocator: selected.primary,
              selectedLocator: `previous-step-container >> ${selector}`,
              fallbackSelected: true,
              fallbackReason:
                "Primary unavailable — deterministic fallback selected.",
              strategy: "previous-step-dom-relation",
              matchCount: attempt.matchCount,
              visibleCount: attempt.visibleCount,
              enabledCount: attempt.enabledCount,
              frame: previous.evidence.frame,
              unique: true,
            },
          };
        }
      }
    }
  }
  for (const selector of positionalArtifactFallbacks) {
    if (selector === selected.primary) continue;
    const attempt = await attemptSelector(
      page,
      expectedOrigin,
      selector,
      visibleOnly,
      enabledOnly,
    );
    if (attempt.eligibleMatches.length === 1) {
      return {
        locator: attempt.eligibleMatches[0].locator,
        evidence: {
          stepId: step.id,
          primaryLocator: selected.primary,
          selectedLocator: selector,
          fallbackSelected: true,
          fallbackReason:
            "Primary unavailable — deterministic fallback selected.",
          strategy: attempt.strategy,
          matchCount: attempt.matchCount,
          visibleCount: attempt.visibleCount,
          enabledCount: attempt.enabledCount,
          frame: attempt.eligibleMatches[0].frame,
          unique: true,
        },
      };
    }
  }
  throw new Error(
    `Step ${step.id} locator resolution failed: primary matches=${primaryAttempt?.matchCount ?? 0}, visible=${primaryAttempt?.visibleCount ?? 0}, enabled=${primaryAttempt?.enabledCount ?? 0}; no unique deterministic fallback.`,
  );
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
      const currentOrigin = new URL(page.url()).origin;
      let visible = false;
      for (const { scope } of sameOriginScopes(page, currentOrigin)) {
        if (
          await scope
            .getByText(expected, { exact: true })
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          visible = true;
          break;
        }
      }
      if (!visible) {
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
  let previous: ResolvedExistingPageLocator | undefined;
  for (const step of input.workflow.steps) {
    const resolved = await resolveSelectedLocator(
      input.page,
      step,
      input.expectedOrigin,
      previous,
    );
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
    previous = resolved;
  }
  return plannedActions;
}

export async function runWorkflowOnExistingPage(input: {
  page: Page;
  workflow: SemanticWorkflow;
  expectedOrigin: string;
  signal?: AbortSignal;
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
  let previous: ResolvedExistingPageLocator | undefined;
  for (const step of input.workflow.steps) {
    const stepStarted = Date.now();
    let resolved: ResolvedExistingPageLocator | undefined;
    try {
      if (input.signal?.aborted) throw new Error("Execution stopped by operator.");
      resolved = await resolveSelectedLocator(
        input.page,
        step,
        input.expectedOrigin,
        previous,
      );
      await verifyStepAssertions(
        input.page,
        resolved.locator,
        step.preconditions,
      );
      await runStepWithTarget(input.page, step, resolved.locator);
      if (input.signal?.aborted) throw new Error("Execution stopped by operator.");
      assertPageOrigin(input.page, input.expectedOrigin);
      steps.push({
        stepId: step.id,
        action: step.action,
        status: "passed",
        durationMs: Date.now() - stepStarted,
        primaryLocator: resolved.evidence.primaryLocator,
        locatorUsed: resolved.evidence.selectedLocator,
        fallbackSelected: resolved.evidence.fallbackSelected,
        fallbackReason: resolved.evidence.fallbackReason,
        matchCount: resolved.evidence.matchCount,
        visibleCount: resolved.evidence.visibleCount,
        enabledCount: resolved.evidence.enabledCount,
        frame: resolved.evidence.frame,
      });
      previous = resolved;
    } catch (error) {
      steps.push({
        stepId: step.id,
        action: step.action,
        status: "failed",
        durationMs: Date.now() - stepStarted,
        primaryLocator: step.selectedLocator?.primary ?? "missing",
        ...(resolved
          ? {
              locatorUsed: resolved.evidence.selectedLocator,
              fallbackSelected: resolved.evidence.fallbackSelected,
              fallbackReason: resolved.evidence.fallbackReason,
              matchCount: resolved.evidence.matchCount,
              visibleCount: resolved.evidence.visibleCount,
              enabledCount: resolved.evidence.enabledCount,
              frame: resolved.evidence.frame,
            }
          : {}),
        errorRedacted:
          error instanceof Error && /stopped by operator/i.test(error.message)
            ? "Execution stopped by operator."
            : "Locator, precondition, action, or postcondition failed.",
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
