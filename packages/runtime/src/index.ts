import { readFile } from "node:fs/promises";
import { chromium, type Frame, type Locator, type Page } from "playwright";
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
  editableCount: number;
  readOnlyCount: number;
  contentEditableCount: number;
  primaryEditableCount?: number;
  tagName?: string;
  inputType?: string;
  accessibleRole?: string;
  isVisible?: boolean;
  isEnabled?: boolean;
  isEditable?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  contentEditable?: boolean;
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
    editableCount?: number;
    readOnlyCount?: number;
    contentEditableCount?: number;
    primaryEditableCount?: number;
    tagName?: string;
    inputType?: string;
    accessibleRole?: string;
    isVisible?: boolean;
    isEnabled?: boolean;
    isEditable?: boolean;
    readOnly?: boolean;
    disabled?: boolean;
    contentEditable?: boolean;
    frame?: string;
    failedPhase?: ExistingPageRuntimePhase;
    phases: ExistingPagePhaseTelemetry[];
    fillStrategy?: FillStrategy;
    fillAttempts?: FillAttemptTelemetry[];
    postconditionNormalized?: "input-value";
    errorRedacted?: string;
  }>;
};

export type ExistingPageRuntimePhase =
  | "locator-resolution"
  | "precondition"
  | "actionability"
  | "action"
  | "postcondition";

export type ExistingPageProgress = {
  stepId: string;
  phase: ExistingPageRuntimePhase;
  label: string;
};

export type ExistingPagePhaseTelemetry = {
  phase: ExistingPageRuntimePhase;
  durationMs: number;
  status: "passed" | "failed";
  message?: string;
};

export type FillStrategy =
  | "playwright-fill"
  | "contenteditable-fill"
  | "keyboard-input"
  | "native-value-setter";

export type FillAttemptTelemetry = {
  strategy: FillStrategy;
  durationMs: number;
  status: "passed" | "failed";
  errorRedacted?: string;
};

type SafeElementState = {
  tagName: string;
  inputType?: string;
  accessibleRole?: string;
  isVisible: boolean;
  isEnabled: boolean;
  isEditable: boolean;
  readOnly: boolean;
  disabled: boolean;
  contentEditable: boolean;
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
            : frame.name() || frameUrl.pathname || `same-origin-frame-${index}`,
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
      strategy: textSelector[1] === "a" ? "anchor-text" : "element-text",
    };
  }
  const elementOrdinal = selector.match(/^([a-z][a-z0-9-]*)\s*>>\s*nth=(\d+)$/);
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
  requireEditable = false,
  scopedContainer?: Locator,
) {
  const scopes = scopedContainer
    ? [{ scope: scopedContainer, id: "previous-step-container" }]
    : sameOriginScopes(page, expectedOrigin);
  const eligibleMatches: Array<{
    locator: Locator;
    frame: string;
    state: SafeElementState;
  }> = [];
  let matchCount = 0;
  let visibleCount = 0;
  let enabledCount = 0;
  let editableCount = 0;
  let readOnlyCount = 0;
  let contentEditableCount = 0;
  let strategy = "unknown";
  for (const scopeEntry of scopes) {
    const resolved = selectorLocator(scopeEntry.scope, selector);
    if (!resolved) continue;
    strategy = resolved.strategy;
    const count = await resolved.locator.count();
    matchCount += count;
    for (let index = 0; index < count; index += 1) {
      const candidate = resolved.locator.nth(index);
      const state = await safeElementState(candidate);
      const visible = state.isVisible;
      const enabled = state.isEnabled;
      visibleCount += Number(visible);
      enabledCount += Number(visible && enabled);
      editableCount += Number(visible && enabled && state.isEditable);
      readOnlyCount += Number(state.readOnly);
      contentEditableCount += Number(state.contentEditable);
      if (
        (!visibleOnly || visible) &&
        (!enabledOnly || enabled) &&
        (!requireEditable ||
          (state.isEditable &&
            !state.readOnly &&
            !state.disabled &&
            isTextCompatible(state)))
      ) {
        eligibleMatches.push({
          locator: candidate,
          frame: scopeEntry.id,
          state,
        });
      }
    }
  }
  return {
    selector,
    strategy,
    matchCount,
    visibleCount,
    enabledCount,
    editableCount,
    readOnlyCount,
    contentEditableCount,
    eligibleMatches,
  };
}

function inferredRole(
  tagName: string,
  inputType?: string,
  explicitRole?: string,
) {
  if (explicitRole) return explicitRole;
  if (tagName === "textarea") return "textbox";
  if (tagName === "button") return "button";
  if (tagName === "select") return "combobox";
  if (tagName === "a") return "link";
  if (tagName === "input") {
    if (["checkbox", "radio", "button", "submit"].includes(inputType ?? "")) {
      return inputType === "submit" || inputType === "button"
        ? "button"
        : inputType;
    }
    return "textbox";
  }
  return undefined;
}

function isTextCompatible(state: SafeElementState) {
  if (state.contentEditable) return true;
  if (state.tagName === "textarea") return true;
  return (
    state.tagName === "input" &&
    ![
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(state.inputType ?? "text")
  );
}

async function safeElementState(locator: Locator): Promise<SafeElementState> {
  const domState = await locator
    .evaluate((element) => {
      const html = element as HTMLElement;
      const control = element as HTMLInputElement | HTMLTextAreaElement;
      return {
        tagName: element.tagName.toLowerCase(),
        inputType:
          element instanceof HTMLInputElement
            ? element.type.toLowerCase()
            : undefined,
        explicitRole: element.getAttribute("role")?.toLowerCase() || undefined,
        readOnly: "readOnly" in control ? Boolean(control.readOnly) : false,
        disabled: "disabled" in control ? Boolean(control.disabled) : false,
        contentEditable: html.isContentEditable,
      };
    })
    .catch(() => ({
      tagName: "unknown",
      inputType: undefined,
      explicitRole: undefined,
      readOnly: false,
      disabled: false,
      contentEditable: false,
    }));
  const [isVisible, isEnabled, isEditable] = await Promise.all([
    locator.isVisible().catch(() => false),
    locator.isEnabled().catch(() => false),
    locator.isEditable({ timeout: 1_500 }).catch(() => false),
  ]);
  return {
    tagName: domState.tagName,
    inputType: domState.inputType,
    accessibleRole: inferredRole(
      domState.tagName,
      domState.inputType,
      domState.explicitRole,
    ),
    isVisible,
    isEnabled,
    isEditable,
    readOnly: domState.readOnly,
    disabled: domState.disabled,
    contentEditable: domState.contentEditable,
  };
}

function evidenceFromAttempt(
  step: SemanticStep,
  selectedLocator: string,
  fallbackReason: string | undefined,
  attempt: Awaited<ReturnType<typeof attemptSelector>>,
): ExistingPageLocatorEvidence {
  const selected = attempt.eligibleMatches[0];
  const state = selected.state;
  return {
    stepId: step.id,
    primaryLocator: step.selectedLocator!.primary,
    selectedLocator,
    fallbackSelected: selectedLocator !== step.selectedLocator!.primary,
    ...(fallbackReason ? { fallbackReason } : {}),
    strategy: attempt.strategy,
    matchCount: attempt.matchCount,
    visibleCount: attempt.visibleCount,
    enabledCount: attempt.enabledCount,
    editableCount: attempt.editableCount,
    readOnlyCount: attempt.readOnlyCount,
    contentEditableCount: attempt.contentEditableCount,
    tagName: state.tagName,
    inputType: state.inputType,
    accessibleRole: state.accessibleRole,
    isVisible: state.isVisible,
    isEnabled: state.isEnabled,
    isEditable: state.isEditable,
    readOnly: state.readOnly,
    disabled: state.disabled,
    contentEditable: state.contentEditable,
    frame: selected.frame,
    unique: true,
  };
}

function semanticHints(step: SemanticStep, workflowName: string) {
  const hints = new Set<string>();
  for (const source of [
    step.target.accessibleName,
    step.selectedLocator?.rule?.candidateText,
    step.intent,
    workflowName,
  ]) {
    if (!source) continue;
    for (const match of source.matchAll(
      /[«\u201c"]([^»\u201d"]+)[»\u201d"]/g,
    )) {
      const hint = match[1]?.trim().toLocaleLowerCase();
      if (hint && hint !== step.value?.trim().toLocaleLowerCase()) {
        hints.add(hint);
      }
    }
  }
  return [...hints];
}

async function resolveEditableFallback(
  page: Page,
  expectedOrigin: string,
  step: SemanticStep,
  workflowName: string,
) {
  const candidates: Array<{
    locator: Locator;
    frame: string;
    state: SafeElementState;
    score: number;
  }> = [];
  const hints = semanticHints(step, workflowName);
  for (const { scope, id } of sameOriginScopes(page, expectedOrigin)) {
    const locator = scope.locator(
      'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], [contenteditable="true"], [role="textbox"]',
    );
    for (let index = 0; index < (await locator.count()); index += 1) {
      const candidate = locator.nth(index);
      const state = await safeElementState(candidate);
      if (
        !state.isVisible ||
        !state.isEnabled ||
        !state.isEditable ||
        state.readOnly ||
        state.disabled ||
        !isTextCompatible(state)
      ) {
        continue;
      }
      const anchorTexts = step.target.relations
        .map((relation) => relation.anchorText)
        .filter((value): value is string => Boolean(value));
      const semantics = await candidate.evaluate((element, expectedAnchors) => {
        const id = element.getAttribute("id");
        const labels = id
          ? [...document.querySelectorAll("label")]
              .filter((label) => label.htmlFor === id)
              .map((label) => label.textContent?.trim() ?? "")
          : [];
        const parentLabel = element.closest("label")?.textContent?.trim() ?? "";
        const container = element.closest(
          "section, fieldset, form, article, main",
        );
        const heading =
          container
            ?.querySelector("legend, h1, h2, h3, h4, h5, h6")
            ?.textContent?.trim() ?? "";
        const hasRelatedAnchor = [
          ...(container?.querySelectorAll(
            "button, a, [role=button], input[type=submit]",
          ) ?? []),
        ].some((control) => {
          const label =
            control instanceof HTMLInputElement
              ? control.value
              : (control.textContent?.trim() ?? "");
          return expectedAnchors.includes(label);
        });
        return {
          ariaLabel: element.getAttribute("aria-label") ?? "",
          placeholder: element.getAttribute("placeholder") ?? "",
          labels: [...labels, parentLabel].filter(Boolean),
          heading,
          hasRelatedAnchor,
        };
      }, anchorTexts);
      const normalized = [
        semantics.ariaLabel,
        semantics.placeholder,
        ...semantics.labels,
        semantics.heading,
      ]
        .filter(Boolean)
        .map((text) => text.toLocaleLowerCase());
      let score = 0;
      for (const hint of hints) {
        if (normalized.some((text) => text === hint)) {
          score = Math.max(score, 100);
        } else if (
          normalized.some((text) => text.includes(hint) || hint.includes(text))
        ) {
          score = Math.max(score, 70);
        }
      }
      if (semantics.hasRelatedAnchor) score += 20;
      candidates.push({ locator: candidate, frame: id, state, score });
    }
  }
  if (candidates.length === 0) return undefined;
  const ordered = [...candidates].sort((a, b) => b.score - a.score);
  const winner = ordered[0];
  if (
    ordered.length > 1 &&
    (winner.score === 0 || winner.score === ordered[1].score)
  ) {
    return undefined;
  }
  return {
    locator: winner.locator,
    evidence: {
      stepId: step.id,
      primaryLocator: step.selectedLocator!.primary,
      selectedLocator: "editable-semantic-fallback",
      fallbackSelected: true,
      fallbackReason:
        "Primary textbox unavailable — unique editable fallback selected.",
      strategy: "editable-semantic-fallback",
      matchCount: candidates.length,
      visibleCount: candidates.length,
      enabledCount: candidates.length,
      editableCount: candidates.length,
      readOnlyCount: 0,
      contentEditableCount: candidates.filter(
        (item) => item.state.contentEditable,
      ).length,
      primaryEditableCount: 0,
      tagName: winner.state.tagName,
      inputType: winner.state.inputType,
      accessibleRole: winner.state.accessibleRole,
      isVisible: winner.state.isVisible,
      isEnabled: winner.state.isEnabled,
      isEditable: winner.state.isEditable,
      readOnly: winner.state.readOnly,
      disabled: winner.state.disabled,
      contentEditable: winner.state.contentEditable,
      frame: winner.frame,
      unique: true as const,
    },
  };
}

async function resolveSelectedLocator(
  page: Page,
  step: SemanticStep,
  expectedOrigin: string,
  workflowName: string,
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
  const positionalArtifactFallbacks =
    artifactFallbacks.filter(positionalSelector);
  const targetName = step.target.accessibleName ?? selected.rule?.candidateText;
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
  let primaryAttempt: Awaited<ReturnType<typeof attemptSelector>> | undefined;
  for (const [index, selector] of semanticSelectors.entries()) {
    const attempt = await attemptSelector(
      page,
      expectedOrigin,
      selector,
      visibleOnly,
      enabledOnly,
      step.action === "fill",
    );
    if (index === 0) primaryAttempt = attempt;
    if (attempt.eligibleMatches.length === 1) {
      return {
        locator: attempt.eligibleMatches[0].locator,
        evidence: evidenceFromAttempt(
          step,
          selector,
          selector !== selected.primary
            ? "Primary unavailable — deterministic fallback selected."
            : undefined,
          attempt,
        ),
      };
    }
  }
  if (
    step.action === "fill" &&
    (primaryAttempt?.visibleCount ?? 0) > 0 &&
    (primaryAttempt?.editableCount ?? 0) === 0
  ) {
    const editableFallback = await resolveEditableFallback(
      page,
      expectedOrigin,
      step,
      workflowName,
    );
    if (editableFallback) {
      editableFallback.evidence.primaryEditableCount =
        primaryAttempt?.editableCount ?? 0;
      editableFallback.evidence.readOnlyCount =
        primaryAttempt?.readOnlyCount ??
        editableFallback.evidence.readOnlyCount;
      return editableFallback;
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
          false,
          container,
        );
        if (attempt.eligibleMatches.length === 1) {
          return {
            locator: attempt.eligibleMatches[0].locator,
            evidence: {
              ...evidenceFromAttempt(
                step,
                `previous-step-container >> ${selector}`,
                "Primary unavailable — deterministic fallback selected.",
                attempt,
              ),
              strategy: "previous-step-dom-relation",
              frame: previous.evidence.frame,
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
      step.action === "fill",
    );
    if (attempt.eligibleMatches.length === 1) {
      return {
        locator: attempt.eligibleMatches[0].locator,
        evidence: evidenceFromAttempt(
          step,
          selector,
          "Primary unavailable — deterministic fallback selected.",
          attempt,
        ),
      };
    }
  }
  throw new Error(
    step.action === "fill"
      ? `Step ${step.id} locator resolution failed: primary matches=${primaryAttempt?.matchCount ?? 0}, visible=${primaryAttempt?.visibleCount ?? 0}, enabled=${primaryAttempt?.enabledCount ?? 0}, editable=${primaryAttempt?.editableCount ?? 0}; no unique editable target.`
      : `Step ${step.id} locator resolution failed: primary matches=${primaryAttempt?.matchCount ?? 0}, visible=${primaryAttempt?.visibleCount ?? 0}, enabled=${primaryAttempt?.enabledCount ?? 0}; no unique deterministic fallback.`,
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

function normalizedControlText(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}

async function readControlText(target: Locator, state: SafeElementState) {
  if (state.contentEditable) {
    return target.textContent({ timeout: 3_000 }).then((value) => value ?? "");
  }
  return target.inputValue({ timeout: 3_000 });
}

async function verifyEnteredValue(
  target: Locator,
  state: SafeElementState,
  expected: string,
) {
  const actual = await readControlText(target, state).catch(() => {
    throw new Error("Entered value verification failed.");
  });
  if (normalizedControlText(actual) !== normalizedControlText(expected)) {
    throw new Error("Entered value verification failed.");
  }
}

function throwIfStopped(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Execution stopped by operator.");
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  throwIfStopped(signal);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Execution stopped by operator.")),
        { once: true },
      );
    }),
  ]);
}

function redactedFillFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/stopped by operator/i.test(message)) {
    return "Execution stopped by operator.";
  }
  if (/not editable|readonly|read-only/i.test(message)) {
    return "Selected element is visible but not editable.";
  }
  if (/no unique editable/i.test(message)) {
    return "No unique editable target was found.";
  }
  if (/timeout/i.test(message)) return "Fill action timed out.";
  if (/verification failed/i.test(message)) {
    return "Entered value verification failed.";
  }
  return "Fill strategy failed.";
}

async function executeFillWithStrategies(input: {
  target: Locator;
  value: string;
  state: SafeElementState;
  labMode: boolean;
  signal?: AbortSignal;
}) {
  const attempts: FillAttemptTelemetry[] = [];
  const attempt = async (
    strategy: FillStrategy,
    operation: () => Promise<unknown>,
  ) => {
    const started = Date.now();
    try {
      throwIfStopped(input.signal);
      await abortable(Promise.resolve(operation()), input.signal);
      throwIfStopped(input.signal);
      await verifyEnteredValue(input.target, input.state, input.value);
      attempts.push({
        strategy,
        durationMs: Date.now() - started,
        status: "passed",
      });
      return true;
    } catch (error) {
      attempts.push({
        strategy,
        durationMs: Date.now() - started,
        status: "failed",
        errorRedacted: redactedFillFailure(error),
      });
      if (
        error instanceof Error &&
        /stopped by operator/i.test(error.message)
      ) {
        throw error;
      }
      return false;
    }
  };

  const initialStrategy: FillStrategy = input.state.contentEditable
    ? "contenteditable-fill"
    : "playwright-fill";
  if (
    await attempt(initialStrategy, async () => {
      await input.target.scrollIntoViewIfNeeded({ timeout: 3_000 });
      await input.target.focus({ timeout: 3_000 });
      await input.target.fill(input.value, { timeout: 8_000 });
    })
  ) {
    return { strategy: initialStrategy, attempts };
  }

  if (
    await attempt("keyboard-input", async () => {
      await input.target.scrollIntoViewIfNeeded({ timeout: 3_000 });
      await input.target.focus({ timeout: 3_000 });
      await input.target.press("ControlOrMeta+A", { timeout: 3_000 });
      await input.target.pressSequentially(input.value, {
        delay: 12,
        timeout: 8_000,
      });
      await input.target.press("Tab", { timeout: 3_000 });
    })
  ) {
    return { strategy: "keyboard-input" as const, attempts };
  }

  if (
    input.labMode &&
    !input.state.contentEditable &&
    ["input", "textarea"].includes(input.state.tagName) &&
    (await attempt("native-value-setter", async () => {
      await input.target.evaluate((element, value) => {
        const control = element as HTMLInputElement | HTMLTextAreaElement;
        if (control.readOnly || control.disabled) {
          throw new Error("Selected element is not editable.");
        }
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) throw new Error("Native value setter unavailable.");
        setter.call(control, value);
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
        control.blur();
      }, input.value);
    }))
  ) {
    return { strategy: "native-value-setter" as const, attempts };
  }

  throw Object.assign(new Error("Entered value verification failed."), {
    fillAttempts: attempts,
  });
}

async function verifyExistingPostconditions(
  page: Page,
  target: Locator,
  step: SemanticStep,
  state: SafeElementState,
) {
  let normalized = false;
  for (const assertion of step.postconditions) {
    const expected = String(assertion.expected ?? assertion.target);
    if (
      step.action === "fill" &&
      assertion.type === "text-visible" &&
      step.value !== undefined &&
      expected === step.value
    ) {
      await verifyEnteredValue(target, state, step.value);
      normalized = true;
      continue;
    }
    await verifyStepAssertions(page, target, [assertion]);
  }
  if (step.action === "fill" && step.value !== undefined) {
    await verifyEnteredValue(target, state, step.value);
    normalized ||= step.postconditions.some(
      (assertion) => assertion.type === "text-visible",
    );
  }
  return normalized;
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
      input.workflow.name,
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
  labMode?: boolean;
  onProgress?: (progress: ExistingPageProgress) => void | Promise<void>;
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
    let state: SafeElementState | undefined;
    let fillResult:
      Awaited<ReturnType<typeof executeFillWithStrategies>> | undefined;
    let failedPhase: ExistingPageRuntimePhase | undefined;
    let postconditionNormalized = false;
    const phases: ExistingPagePhaseTelemetry[] = [];
    const phase = async <T>(
      phaseName: ExistingPageRuntimePhase,
      label: string,
      operation: () => Promise<T>,
    ) => {
      const phaseStarted = Date.now();
      await input.onProgress?.({ stepId: step.id, phase: phaseName, label });
      try {
        const result = await operation();
        phases.push({
          phase: phaseName,
          durationMs: Date.now() - phaseStarted,
          status: "passed",
        });
        return result;
      } catch (error) {
        failedPhase = phaseName;
        phases.push({
          phase: phaseName,
          durationMs: Date.now() - phaseStarted,
          status: "failed",
          message:
            step.action === "fill"
              ? redactedFillFailure(error)
              : "Phase failed.",
        });
        throw error;
      }
    };
    try {
      throwIfStopped(input.signal);
      resolved = await phase(
        "locator-resolution",
        step.action === "click"
          ? `Resolving ${selectedLocatorLabel(step)}`
          : "Resolving target",
        () =>
          resolveSelectedLocator(
            input.page,
            step,
            input.expectedOrigin,
            input.workflow.name,
            previous,
          ),
      );
      await phase("precondition", "Checking preconditions", () =>
        verifyStepAssertions(input.page, resolved!.locator, step.preconditions),
      );
      state = await phase(
        "actionability",
        step.action === "fill"
          ? "Checking editability"
          : "Checking actionability",
        async () => {
          const current = await safeElementState(resolved!.locator);
          if (!current.isVisible) {
            throw new Error("Selected element is not visible.");
          }
          if (!current.isEnabled || current.disabled) {
            throw new Error("Selected element is disabled.");
          }
          if (
            step.action === "fill" &&
            (!current.isEditable ||
              current.readOnly ||
              !isTextCompatible(current))
          ) {
            throw new Error("Selected element is visible but not editable.");
          }
          return current;
        },
      );
      await phase(
        "action",
        step.action === "fill"
          ? "Filling field"
          : step.action === "click"
            ? `Clicking ${selectedLocatorLabel(step)}`
            : `Running ${step.action}`,
        async () => {
          throwIfStopped(input.signal);
          if (step.action === "fill") {
            fillResult = await executeFillWithStrategies({
              target: resolved!.locator,
              value: step.value ?? "",
              state: state!,
              labMode: input.labMode === true,
              signal: input.signal,
            });
          } else {
            await abortable(
              (async () => {
                if (step.action === "check")
                  await resolved!.locator.check({ timeout: 8_000 });
                else if (step.action === "uncheck")
                  await resolved!.locator.uncheck({ timeout: 8_000 });
                else if (step.action === "click")
                  await resolved!.locator.click({ timeout: 8_000 });
                else if (step.action === "select")
                  await resolved!.locator.selectOption(step.value ?? "", {
                    timeout: 8_000,
                  });
                else if (step.action === "wait")
                  await resolved!.locator.waitFor({
                    state: "visible",
                    timeout: 8_000,
                  });
                else if (step.action === "assert")
                  await resolved!.locator.waitFor({
                    state: "visible",
                    timeout: 8_000,
                  });
                else
                  throw new Error(`Unsupported runtime action: ${step.action}`);
              })(),
              input.signal,
            );
          }
        },
      );
      postconditionNormalized = await phase(
        "postcondition",
        step.action === "fill"
          ? "Verifying entered value"
          : "Verifying postconditions",
        () =>
          verifyExistingPostconditions(
            input.page,
            resolved!.locator,
            step,
            state!,
          ),
      );
      throwIfStopped(input.signal);
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
        editableCount: resolved.evidence.editableCount,
        readOnlyCount: resolved.evidence.readOnlyCount,
        contentEditableCount: resolved.evidence.contentEditableCount,
        primaryEditableCount: resolved.evidence.primaryEditableCount,
        tagName: state.tagName,
        inputType: state.inputType,
        accessibleRole: state.accessibleRole,
        isVisible: state.isVisible,
        isEnabled: state.isEnabled,
        isEditable: state.isEditable,
        readOnly: state.readOnly,
        disabled: state.disabled,
        contentEditable: state.contentEditable,
        frame: resolved.evidence.frame,
        phases,
        ...(fillResult
          ? {
              fillStrategy: fillResult.strategy,
              fillAttempts: fillResult.attempts,
            }
          : {}),
        ...(postconditionNormalized
          ? { postconditionNormalized: "input-value" as const }
          : {}),
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
              editableCount: resolved.evidence.editableCount,
              readOnlyCount: resolved.evidence.readOnlyCount,
              contentEditableCount: resolved.evidence.contentEditableCount,
              primaryEditableCount: resolved.evidence.primaryEditableCount,
              tagName: resolved.evidence.tagName,
              inputType: resolved.evidence.inputType,
              accessibleRole: resolved.evidence.accessibleRole,
              isVisible: resolved.evidence.isVisible,
              isEnabled: resolved.evidence.isEnabled,
              isEditable: resolved.evidence.isEditable,
              readOnly: resolved.evidence.readOnly,
              disabled: resolved.evidence.disabled,
              contentEditable: resolved.evidence.contentEditable,
              frame: resolved.evidence.frame,
            }
          : {}),
        failedPhase,
        phases,
        ...(fillResult
          ? {
              fillStrategy: fillResult.strategy,
              fillAttempts: fillResult.attempts,
            }
          : error && typeof error === "object" && "fillAttempts" in error
            ? {
                fillAttempts: (
                  error as { fillAttempts: FillAttemptTelemetry[] }
                ).fillAttempts,
              }
            : {}),
        errorRedacted:
          error instanceof Error && /stopped by operator/i.test(error.message)
            ? "Execution stopped by operator."
            : step.action === "fill"
              ? redactedFillFailure(error)
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
