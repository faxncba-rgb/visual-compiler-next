import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  compileWorkflow,
  createRedactedCompilerPageModel,
} from "@visual-compiler/compiler";
import { extractPageModel, type PageModel } from "@visual-compiler/page-model";
import { generateCandidates } from "@visual-compiler/locator-engine";
import {
  inspectWorkflowOnExistingPage,
  runCompiledWorkflow,
  runWorkflowOnExistingPage,
  type ExistingPagePlannedAction,
  type ExistingPageProgress,
} from "@visual-compiler/runtime";
import {
  createStudioApplicationProfiles,
  clinicalPreflight,
  compareStructuralFingerprints,
  computeWorkflowHash,
  createRedactedAudit,
  createStructuralFingerprint,
  localFixtureProfile,
  redactPageModel,
  resolveStudioProfileTarget,
  requireValidAttestation,
  StudioProfileIdSchema,
  transitionWorkflow,
  WorkflowStateSchema,
  type PromotedWorkflow,
  type RedactedPageModel,
  type StructuralFingerprint,
  type StudioProfileId,
  type WorkflowState,
} from "@visual-compiler/clinical-safety";
import {
  SemanticWorkflowSchema,
  type SemanticWorkflow,
} from "@visual-compiler/semantic-ir";
import {
  DEFAULT_DEMO_INTERNAL_URL,
  DEFAULT_DEMO_PUBLIC_URL,
  DEFAULT_INSTRUCTION,
  WORKFLOW_PATH,
  WORKFLOW_STORAGE_DIR,
  canonicalizeTargetUrl,
} from "@visual-compiler/shared";

const port = Number(process.env.STUDIO_PORT ?? 3000);
const host = process.env.STUDIO_HOST ?? "0.0.0.0";
const labModeEnabled =
  process.env.VISUAL_COMPILER_LAB_MODE === "true" &&
  ["127.0.0.1", "localhost", "::1"].includes(host);
const defaultWorkflowId = path.basename(WORKFLOW_PATH, ".json");
const lifecycleStorageDirectory = path.join(WORKFLOW_STORAGE_DIR, ".state");
const compilationRequests = new Map<
  string,
  {
    stage: CompileProgressStage;
    complete: boolean;
    error?: string;
    updatedAt: string;
  }
>();
const activeCompilationKeys = new Set<string>();
const labSessions = new Map<
  string,
  { confirmedAt: string; expiresAt: number }
>();
const activeLabRuns = new Map<StudioProfileId, AbortController>();
const labRunProgress = new Map<
  StudioProfileId,
  {
    running: boolean;
    current?: ExistingPageProgress;
    updatedAt: string;
  }
>();
const LAB_SESSION_TTL_MS = 12 * 60 * 60_000;
const COMPILE_RESPONSE_TIMEOUT_MS = 180_000;
const compileProgressDelayMs = Math.max(
  0,
  Math.min(
    1_000,
    Number.parseInt(process.env.COMPILER_PROGRESS_DELAY_MS ?? "0", 10) || 0,
  ),
);
const compileProgressStages = [
  "Preparing redacted payload",
  "Calling GPT-5.6",
  "Validating Semantic IR",
  "Generating locators",
  "Saving artifact",
  "Compilation complete",
] as const;
type CompileProgressStage = (typeof compileProgressStages)[number];
const browserProfileRoot = path.resolve(
  process.env.VISUAL_COMPILER_BROWSER_PROFILE_ROOT ??
    path.join(
      homedir(),
      "Library",
      "Application Support",
      "Visual Compiler Next",
      "browser-profiles",
    ),
);
if (
  browserProfileRoot.startsWith(`${path.resolve(process.cwd())}${path.sep}`)
) {
  throw new Error("Browser profile storage must be outside the repository.");
}

function normalizedBaseUrl(value: string, variableName: string) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error();
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${variableName} must be a valid HTTP(S) URL.`);
  }
}

const internalDemoUrl = normalizedBaseUrl(
  DEFAULT_DEMO_INTERNAL_URL,
  "DEMO_SITE_INTERNAL_URL",
);
const publicDemoUrl = normalizedBaseUrl(
  DEFAULT_DEMO_PUBLIC_URL,
  "DEMO_SITE_PUBLIC_URL",
);
const managedTrainingOrigin = normalizedBaseUrl(
  process.env.NCBA_TRAINING_ORIGIN ?? "https://dpi-ncba.gbna-sante.fr",
  "NCBA_TRAINING_ORIGIN",
);
const allowExplicitLocalSsoFixture =
  process.env.ALLOW_EXPLICIT_LOCAL_SSO_FIXTURE === "true" &&
  ["127.0.0.1", "localhost"].includes(new URL(managedTrainingOrigin).hostname);
const syntheticSsoAuthOrigin = allowExplicitLocalSsoFixture
  ? normalizedBaseUrl(
      process.env.SSO_FIXTURE_AUTH_ORIGIN ?? "http://127.0.0.1:4275",
      "SSO_FIXTURE_AUTH_ORIGIN",
    )
  : null;
const studioProfiles = createStudioApplicationProfiles(
  publicDemoUrl,
  managedTrainingOrigin,
);
function resolveStudioTarget(
  input: Omit<
    Parameters<typeof resolveStudioProfileTarget>[0],
    "fixtureOrigin" | "trainingOrigin" | "allowExplicitLocalFixture"
  >,
) {
  return resolveStudioProfileTarget({
    ...input,
    fixtureOrigin: publicDemoUrl,
    trainingOrigin: managedTrainingOrigin,
    allowExplicitLocalFixture: allowExplicitLocalSsoFixture,
  });
}
type ManagedBrowserPhase = "authentication-bootstrap" | "application-locked";
type ManagedBrowserSession = {
  id: string;
  browser: Browser;
  context: BrowserContext;
  primaryPage: Page;
  phase: ManagedBrowserPhase;
  applicationOrigin: string;
};
const managedSessions = new Map<StudioProfileId, ManagedBrowserSession>();
type CaptureRecord = {
  id: string;
  studioProfileId: StudioProfileId;
  pageModel: PageModel;
  redactedModel: RedactedPageModel;
  fingerprint: StructuralFingerprint;
  attestedAt: string;
  managedSessionId?: string;
  compilerPayload: ReturnType<typeof createRedactedCompilerPageModel>;
  compilerPayloadSha256: string;
};
const captures = new Map<string, CaptureRecord>();
type LifecycleRecord = {
  workflow: SemanticWorkflow;
  state: WorkflowState;
  captureId?: string;
  studioProfileId: StudioProfileId;
  canonicalUrl: string;
  compilerPayloadSha256: string;
  structuralFingerprint: StructuralFingerprint;
  idempotencyKey: string;
  artifactSha256: string;
  createdAt: string;
  updatedAt: string;
  validation?: {
    passed: boolean;
    variants: Array<{ variant: "A" | "B"; passed: boolean }>;
    trainingTest?: {
      passed: boolean;
      validatedAt: string;
      stepIds: string[];
      llmCalls: 0;
      openAIRequests: 0;
    };
  };
  approvalTimestamp?: string;
  promotion?: PromotedWorkflow;
  lastPreflight?: ReturnType<typeof clinicalPreflight>;
};
const lifecycleRecords = new Map<string, LifecycleRecord>();
type TrainingExecutionPreflight = {
  token: string;
  workflowId: string;
  captureId: string;
  managedSessionId: string;
  canonicalUrl: string;
  fingerprintSha256: string;
  plannedActions: ExistingPagePlannedAction[];
  expiresAt: number;
};
const trainingExecutionPreflights = new Map<
  string,
  TrainingExecutionPreflight
>();
const TRAINING_EXECUTION_PREFLIGHT_TTL_MS = 5 * 60_000;

function isLabProfile(profileId: StudioProfileId) {
  return profileId === "ncba-dpi-training" || profileId === "ncba-dpi-fixture";
}

function isLabAuthorized(token: unknown, profileId: StudioProfileId) {
  if (!labModeEnabled || !isLabProfile(profileId) || typeof token !== "string")
    return false;
  const session = labSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) labSessions.delete(token);
    return false;
  }
  return true;
}

function normalizeInstructionForIdentity(instruction: string) {
  return instruction.normalize("NFC").trim().replace(/\s+/g, " ");
}

function compileIdempotencyKey(input: {
  instruction: string;
  studioProfileId: StudioProfileId;
  canonicalUrl: string;
  compilerPayloadSha256: string;
}) {
  const canonical = new URL(canonicalizeTargetUrl(input.canonicalUrl));
  return createHash("sha256")
    .update(
      JSON.stringify({
        instruction: normalizeInstructionForIdentity(input.instruction),
        profileId: input.studioProfileId,
        origin: canonical.origin,
        pathname: canonical.pathname,
        compilerPayloadSha256: input.compilerPayloadSha256,
      }),
    )
    .digest("hex");
}

function artifactLogicalPath(workflowId: string) {
  return `compiled-workflows/${workflowId}.json`;
}

function lifecyclePath(workflowId: string) {
  return path.join(lifecycleStorageDirectory, `${workflowId}.lifecycle.json`);
}

function idempotencyPath(idempotencyKey: string) {
  return path.join(
    lifecycleStorageDirectory,
    `${idempotencyKey}.idempotency.json`,
  );
}

function artifactSha256(serialized: string) {
  return createHash("sha256").update(serialized).digest("hex");
}

function assertWorkflowArtifactPrivacy(
  workflow: SemanticWorkflow,
  serialized: string,
) {
  for (const candidateUrl of [
    workflow.source.url,
    workflow.metadata.targetUrl,
  ]) {
    const url = new URL(candidateUrl);
    const safeLegacyFixtureQuery =
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      [...url.searchParams.keys()].every((key) => key === "variant");
    if (
      (url.search && !safeLegacyFixtureQuery) ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error("Workflow artifact contains a non-canonical URL.");
    }
  }
  if (
    /(?:patient_id|mytime|session[_-]?token|bootstrap[_-]?token|popup[_-]?token|frame[_-]?token|bearer\s+)/i.test(
      serialized,
    )
  ) {
    throw new Error("Workflow artifact failed the sensitive-token scan.");
  }
  const forbiddenKeys = new Set([
    "cookie",
    "cookies",
    "localstorage",
    "sessionstorage",
    "authorization",
    "requestheaders",
    "responseheaders",
    "capturedvalue",
    "capturedvalues",
  ]);
  const inspectKeys = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspectKeys);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLowerCase())) {
        throw new Error("Workflow artifact contains a forbidden field.");
      }
      inspectKeys(child);
    }
  };
  inspectKeys(workflow);
}

async function readWorkflowArtifact(workflowId: string) {
  const serialized = await readFile(workflowArtifactPath(workflowId), "utf8");
  const workflow = SemanticWorkflowSchema.parse(JSON.parse(serialized));
  assertWorkflowArtifactPrivacy(workflow, serialized);
  return {
    workflow,
    serialized,
    sha256: artifactSha256(serialized),
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function demoUrl(baseUrl: string, variant: "A" | "B") {
  return `${baseUrl}/demo?variant=${variant}`;
}

function fixtureUrl(baseUrl: string, variant: "A" | "B", mode = "training") {
  return `${baseUrl}/ncba-fixture?mode=${mode}&variant=${variant}`;
}

function redactCapturedPageModel(model: PageModel) {
  return redactPageModel({
    url: model.url,
    nodes: model.nodes.map((node) => ({
      tagName: node.tagName,
      role: node.role,
      label: node.attributes["data-vc-stable-label"],
      text: node.text,
      value: node.attributes.value,
      selectedValue: node.attributes.selected,
      checked: node.checked,
      enabled: node.enabled,
      visible: node.visible,
      required: node.attributes.required !== undefined,
      box: node.box,
      attributes: node.attributes,
    })),
  });
}

async function captureLocalFixture(url: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    if (isOpenAIHost(new URL(route.request().url()).hostname)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  try {
    const page = await context.newPage();
    await page.goto(url);
    return await extractPageModel(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function extractManagedPageModel(
  page: Page,
  applicationOrigin: string,
): Promise<PageModel> {
  const sameOriginFrames = page.frames().filter((frame) => {
    try {
      return new URL(frame.url()).origin === applicationOrigin;
    } catch {
      return false;
    }
  });
  const models = await Promise.all(
    sameOriginFrames.map(async (frame, index) => {
      const model = await extractPageModel(frame);
      const prefix = `f${index}-`;
      let title: string | undefined;
      if (frame !== page.mainFrame()) {
        title =
          (await frame
            .frameElement()
            .then((element) => element.getAttribute("title"))
            .catch(() => null)) ?? undefined;
      }
      const frameIdentity =
        frame === page.mainFrame()
          ? undefined
          : {
              name: frame.name() || undefined,
              title,
              pathname: new URL(frame.url()).pathname,
              index,
            };
      return model.nodes.map((node) => ({
        ...node,
        id: `${prefix}${node.id}`,
        parentId: node.parentId ? `${prefix}${node.parentId}` : undefined,
        previousSiblingId: node.previousSiblingId
          ? `${prefix}${node.previousSiblingId}`
          : undefined,
        nextSiblingId: node.nextSiblingId
          ? `${prefix}${node.nextSiblingId}`
          : undefined,
        frame: frameIdentity,
      }));
    }),
  );
  return {
    url: page.url(),
    viewport: page.viewportSize() ?? { width: 1280, height: 720 },
    nodes: models.flat(),
    capturedAt: new Date().toISOString(),
  };
}

function fixtureApplicationProfile() {
  const origin = new URL(internalDemoUrl).origin;
  return {
    ...localFixtureProfile,
    trainingOrigins: [origin],
    runtimeOrigins: [origin],
  };
}

function lifecycleSummary(record: LifecycleRecord) {
  return {
    workflowId: record.workflow.id,
    workflowName: record.workflow.name,
    state: record.state,
    validation: record.validation,
    approvalTimestamp: record.approvalTimestamp,
    promotion: record.promotion
      ? {
          workflowSha256: record.promotion.workflowSha256,
          promotionTimestamp: record.promotion.promotionTimestamp,
          runtimeOpenAIPolicy: record.promotion.runtimeOpenAIPolicy,
        }
      : undefined,
    preflight: record.lastPreflight,
  };
}

function persistedLifecycle(record: LifecycleRecord) {
  return {
    version: 1,
    workflowId: record.workflow.id,
    artifactPath: artifactLogicalPath(record.workflow.id),
    artifactSha256: record.artifactSha256,
    state: record.state,
    studioProfileId: record.studioProfileId,
    canonicalUrl: record.canonicalUrl,
    compilerPayloadSha256: record.compilerPayloadSha256,
    structuralFingerprint: record.structuralFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    validation: record.validation,
    approvalTimestamp: record.approvalTimestamp,
    promotion: record.promotion,
  };
}

async function writeJsonAtomically(destination: string, value: unknown) {
  const temporaryPath = `${destination}.${randomUUID()}.tmp.json`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), {
      mode: 0o600,
    });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function persistLifecycle(record: LifecycleRecord) {
  record.updatedAt = new Date().toISOString();
  await writeJsonAtomically(
    lifecyclePath(record.workflow.id),
    persistedLifecycle(record),
  );
  await writeJsonAtomically(idempotencyPath(record.idempotencyKey), {
    version: 1,
    idempotencyKey: record.idempotencyKey,
    workflowId: record.workflow.id,
    artifactPath: artifactLogicalPath(record.workflow.id),
    artifactSha256: record.artifactSha256,
    updatedAt: record.updatedAt,
  });
}

async function loadPersistedLifecycle(workflowId: string) {
  const parsed = JSON.parse(
    await readFile(lifecyclePath(workflowId), "utf8"),
  ) as {
    state: WorkflowState;
    studioProfileId: StudioProfileId;
    canonicalUrl: string;
    compilerPayloadSha256: string;
    structuralFingerprint: StructuralFingerprint;
    idempotencyKey: string;
    artifactSha256: string;
    createdAt: string;
    updatedAt: string;
    validation?: LifecycleRecord["validation"];
    approvalTimestamp?: string;
    promotion?: PromotedWorkflow;
  };
  const artifact = await readWorkflowArtifact(workflowId);
  if (artifact.sha256 !== parsed.artifactSha256) {
    throw new Error("Persisted workflow hash does not match its artifact.");
  }
  const record: LifecycleRecord = {
    workflow: artifact.workflow,
    state: WorkflowStateSchema.parse(parsed.state),
    studioProfileId: StudioProfileIdSchema.parse(parsed.studioProfileId),
    canonicalUrl: canonicalizeTargetUrl(parsed.canonicalUrl),
    compilerPayloadSha256: parsed.compilerPayloadSha256,
    structuralFingerprint: parsed.structuralFingerprint,
    idempotencyKey: parsed.idempotencyKey,
    artifactSha256: parsed.artifactSha256,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    validation: parsed.validation,
    approvalTimestamp: parsed.approvalTimestamp,
    promotion: parsed.promotion,
  };
  lifecycleRecords.set(workflowId, record);
  return record;
}

async function hydrateLifecycleRecords() {
  await ensureWorkflowStorage();
  const entries = await readdir(lifecycleStorageDirectory, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".lifecycle.json")) continue;
    const workflowId = entry.name.slice(0, -".lifecycle.json".length);
    try {
      await loadPersistedLifecycle(workflowId);
    } catch {
      // Fail closed: invalid or altered state is not made executable.
    }
  }
}

async function ensureWorkflowStorage() {
  await mkdir(WORKFLOW_STORAGE_DIR, { recursive: true });
  await mkdir(lifecycleStorageDirectory, { recursive: true, mode: 0o700 });
  const seedPath = process.env.E2E_SEED_WORKFLOW_PATH;
  if (seedPath && !existsSync(WORKFLOW_PATH)) {
    await copyFile(path.resolve(seedPath), WORKFLOW_PATH);
  }
  await access(WORKFLOW_STORAGE_DIR, constants.R_OK | constants.W_OK);
}

function isOpenAIHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "openai.com" || normalized.endsWith(".openai.com");
}

function isPermittedManagedRequestUrl(url: URL) {
  if (url.protocol === "https:") return true;
  return (
    allowExplicitLocalSsoFixture &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname)
  );
}

async function openManagedBrowser(profileId: StudioProfileId, target: URL) {
  const existing = managedSessions.get(profileId);
  if (existing) {
    await existing.context.close();
    await existing.browser.close();
    managedSessions.delete(profileId);
  }
  const browser = await chromium.launch({
    headless: process.env.MANAGED_BROWSER_HEADLESS === "true",
  });
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: null,
  });
  const primaryPage = await context.newPage();
  const session: ManagedBrowserSession = {
    id: randomUUID(),
    browser,
    context,
    primaryPage,
    phase: "authentication-bootstrap",
    applicationOrigin: target.origin,
  };
  managedSessions.set(profileId, session);
  context.on("close", () => managedSessions.delete(profileId));
  context.on("page", (page) => {
    if (
      session.phase === "application-locked" &&
      page !== session.primaryPage
    ) {
      void page.close();
    }
  });
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      isOpenAIHost(requestUrl.hostname) ||
      !isPermittedManagedRequestUrl(requestUrl)
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    let isPrimaryPageNavigation = false;
    if (route.request().isNavigationRequest()) {
      try {
        isPrimaryPageNavigation =
          route.request().frame() === session.primaryPage.mainFrame();
      } catch {
        // Popup navigation can be issued before Playwright creates its frame.
        // It is allowed during bootstrap and is never mistaken for the
        // primary application page.
        isPrimaryPageNavigation = false;
      }
    }
    if (
      session.phase === "application-locked" &&
      isPrimaryPageNavigation &&
      requestUrl.origin !== session.applicationOrigin
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket(
    (url) => isOpenAIHost(url.hostname),
    (webSocket) =>
      webSocket.close({
        code: 1008,
        reason: "OpenAI network access is forbidden in managed browsers.",
      }),
  );
  try {
    // Authentication portals and professional CGI applications can keep the
    // load event pending. The bootstrap only needs the first committed
    // navigation; origin polling observes subsequent SSO redirects.
    await primaryPage.goto(target.toString(), {
      waitUntil: "commit",
      timeout: 10_000,
    });
    await primaryPage.bringToFront();
    return session;
  } catch (error) {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    managedSessions.delete(profileId);
    throw error;
  }
}

function managedSessionStatus(session: ManagedBrowserSession) {
  let currentOrigin: string | null = null;
  try {
    const current = new URL(session.primaryPage.url());
    if (["http:", "https:"].includes(current.protocol)) {
      currentOrigin = current.origin;
    }
  } catch {
    currentOrigin = null;
  }
  return {
    phase: session.phase,
    applicationOrigin: session.applicationOrigin,
    currentOrigin,
    canLock:
      session.phase === "authentication-bootstrap" &&
      currentOrigin === session.applicationOrigin,
    popupCount: Math.max(0, session.context.pages().length - 1),
    captureAllowed: session.phase === "application-locked",
    compilationAllowed: session.phase === "application-locked",
    llmCalls: 0,
    openAIRequests: 0,
  };
}

async function lockManagedBrowserToApplication(session: ManagedBrowserSession) {
  const status = managedSessionStatus(session);
  if (!status.canLock) {
    throw new Error("Primary page has not returned to the application origin.");
  }
  session.phase = "application-locked";
  for (const page of session.context.pages()) {
    if (page !== session.primaryPage) await page.close();
  }
  await session.primaryPage.bringToFront();
  return managedSessionStatus(session);
}

function assertSelectedCandidatesDeclaredUnique(workflow: SemanticWorkflow) {
  for (const step of workflow.steps) {
    if (!step.selectedLocator) {
      throw new Error(`Step ${step.id} has no selected locator.`);
    }
    const selectedCandidate = step.candidates.find(
      (candidate) => candidate.selector === step.selectedLocator?.primary,
    );
    if (selectedCandidate && !selectedCandidate.unique) {
      throw new Error(`Step ${step.id} selected locator is not unique.`);
    }
  }
}

async function prepareLockedTrainingExecution(
  workflowId: string,
  allowedStates: WorkflowState[] = ["Draft"],
): Promise<{
  record: LifecycleRecord;
  capture: CaptureRecord;
  session: ManagedBrowserSession;
  canonicalUrl: string;
  fingerprint: StructuralFingerprint;
  compatibility: ReturnType<typeof compareStructuralFingerprints>;
  plannedActions: ExistingPagePlannedAction[];
}> {
  const record = lifecycleRecords.get(workflowId);
  if (!record) throw new Error("Workflow lifecycle record not found.");
  if (
    !allowedStates.includes(record.state) ||
    record.studioProfileId !== "ncba-dpi-training"
  ) {
    throw new Error("A restored ncba-dpi-training Draft is required.");
  }
  const capture = record.captureId ? captures.get(record.captureId) : undefined;
  if (
    !capture ||
    capture.studioProfileId !== "ncba-dpi-training" ||
    !capture.managedSessionId
  ) {
    throw new Error("The Draft is not attached to a current Training capture.");
  }
  const session = managedSessions.get("ncba-dpi-training");
  if (
    !session ||
    session.phase !== "application-locked" ||
    session.id !== capture.managedSessionId
  ) {
    throw new Error(
      "The locked managed session is not the session used for this capture.",
    );
  }
  const configuredOrigin = new URL(managedTrainingOrigin).origin;
  if (session.applicationOrigin !== configuredOrigin) {
    throw new Error(
      "The managed application origin is not the Training origin.",
    );
  }
  const currentUrl = new URL(session.primaryPage.url());
  if (currentUrl.origin !== configuredOrigin) {
    throw new Error("The managed page is not on the exact Training origin.");
  }
  const canonicalUrl = canonicalizeTargetUrl(currentUrl.toString());
  if (
    canonicalUrl !== record.canonicalUrl ||
    canonicalUrl !== canonicalizeTargetUrl(record.workflow.source.url)
  ) {
    throw new Error("The managed page pathname does not match the Draft.");
  }
  assertSelectedCandidatesDeclaredUnique(record.workflow);
  const currentPageModel = await extractManagedPageModel(
    session.primaryPage,
    session.applicationOrigin,
  );
  const currentFingerprint = createStructuralFingerprint(
    redactCapturedPageModel(currentPageModel),
  );
  const compatibility = compareStructuralFingerprints(
    record.structuralFingerprint,
    currentFingerprint,
  );
  if (!compatibility.compatible) {
    throw new Error("The locked Training page is structurally incompatible.");
  }
  const plannedActions = await inspectWorkflowOnExistingPage({
    page: session.primaryPage,
    workflow: record.workflow,
    expectedOrigin: configuredOrigin,
  });
  if (
    plannedActions.length !== record.workflow.steps.length ||
    plannedActions.some(
      (action) => !action.locator.unique || !action.preconditionsPassed,
    )
  ) {
    throw new Error("Locator uniqueness or precondition validation failed.");
  }
  return {
    record,
    capture,
    session,
    canonicalUrl,
    fingerprint: currentFingerprint,
    compatibility,
    plannedActions,
  };
}

function workflowArtifactPath(workflowId: string) {
  if (!/^[a-z0-9][a-z0-9.-]{0,119}$/.test(workflowId)) {
    throw new Error("Invalid workflow artifact id.");
  }
  return path.join(WORKFLOW_STORAGE_DIR, `${workflowId}.json`);
}

async function listWorkflowArtifacts() {
  await ensureWorkflowStorage();
  const entries = await readdir(WORKFLOW_STORAGE_DIR, { withFileTypes: true });
  const workflows = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        try {
          const workflow = JSON.parse(
            await readFile(path.join(WORKFLOW_STORAGE_DIR, entry.name), "utf8"),
          );
          return {
            id: path.basename(entry.name, ".json"),
            name: String(workflow.name ?? path.basename(entry.name, ".json")),
            compiledAt: String(workflow.compiledAt ?? ""),
            interpretationSource: String(
              workflow.diagnostics?.interpretationSource ?? "unknown",
            ),
          };
        } catch {
          return null;
        }
      }),
  );
  return workflows
    .filter((workflow) => workflow !== null)
    .sort((a, b) => b.compiledAt.localeCompare(a.compiledAt));
}

function updateCompilationProgress(
  requestId: string,
  stage: CompileProgressStage,
  options: { complete?: boolean; error?: string } = {},
) {
  compilationRequests.set(requestId, {
    stage,
    complete: options.complete ?? stage === "Compilation complete",
    error: options.error,
    updatedAt: new Date().toISOString(),
  });
}

function scheduleCompilationProgressCleanup(requestId: string) {
  const cleanup = setTimeout(
    () => compilationRequests.delete(requestId),
    10 * 60_000,
  );
  cleanup.unref();
}

function summarizedDiagnostics(workflow: SemanticWorkflow) {
  return {
    modelCalls: workflow.diagnostics.modelCalls,
    interpretationSource: workflow.diagnostics.interpretationSource,
    responseModel: workflow.diagnostics.responseModel,
    tokenUsage: workflow.diagnostics.tokenUsage,
    durationMs: workflow.diagnostics.durationMs,
    rejected: workflow.diagnostics.rejected,
    stepCount: workflow.steps.length,
    locatorDiagnostics: workflow.diagnostics.locatorDiagnostics,
  };
}

function compactCompileResponse(
  record: LifecycleRecord,
  options: { reused: boolean },
) {
  return {
    workflowId: record.workflow.id,
    artifactPath: artifactLogicalPath(record.workflow.id),
    lifecycle: { state: record.state },
    diagnostics: summarizedDiagnostics(record.workflow),
    reused: options.reused,
  };
}

function artifactInstruction(workflow: SemanticWorkflow) {
  return normalizeInstructionForIdentity(
    workflow.name.replace(/\s*\[[a-f0-9]{8}\]\s*$/i, ""),
  );
}

function validateArtifactAgainstCapture(input: {
  workflow: SemanticWorkflow;
  capture: CaptureRecord;
  studioProfileId: StudioProfileId;
  canonicalUrl: string;
  persisted?: LifecycleRecord;
}) {
  if (canonicalizeTargetUrl(input.workflow.source.url) !== input.canonicalUrl) {
    throw new Error("Artifact origin or pathname does not match the capture.");
  }
  if (
    input.persisted &&
    input.persisted.studioProfileId !== input.studioProfileId
  ) {
    throw new Error("Artifact was compiled for a different Training profile.");
  }
  const fingerprintCompatibility = input.persisted
    ? compareStructuralFingerprints(
        input.persisted.structuralFingerprint,
        input.capture.fingerprint,
      )
    : {
        compatible: true,
        score: 1,
        missingRequired: [] as string[],
        differencesRedacted: [] as string[],
      };
  if (!fingerprintCompatibility.compatible) {
    throw new Error("Artifact structural fingerprint is not compatible.");
  }
  const locatorChecks = input.workflow.steps.map((step) => {
    const candidates = generateCandidates(input.capture.pageModel, step);
    const primary = candidates.find(
      (candidate) => candidate.selector === step.selectedLocator?.primary,
    );
    const orderedArtifactSelectors = [
      step.selectedLocator?.primary,
      ...step.candidates.map((candidate) => candidate.selector),
      step.selectedLocator?.fallback,
    ].filter((selector): selector is string => Boolean(selector));
    const fallback = orderedArtifactSelectors
      .filter((selector) => selector !== step.selectedLocator?.primary)
      .map((selector) =>
        candidates.find(
          (candidate) => candidate.selector === selector && candidate.unique,
        ),
      )
      .find((candidate) => candidate !== undefined);
    return {
      stepId: step.id,
      candidateCount: candidates.length,
      primaryUnique: primary?.unique === true,
      deterministicFallback: fallback?.selector,
      restorable: primary?.unique === true || Boolean(fallback),
    };
  });
  if (locatorChecks.some((check) => !check.restorable)) {
    throw new Error(
      "Artifact restoration refused: a selected locator is missing or ambiguous.",
    );
  }
  return {
    structuralCompatibility: fingerprintCompatibility.score,
    locatorChecks,
  };
}

async function createDraftRecord(input: {
  workflow: SemanticWorkflow;
  capture: CaptureRecord;
  studioProfileId: StudioProfileId;
  canonicalUrl: string;
  idempotencyKey: string;
  artifactSha256: string;
}) {
  const now = new Date().toISOString();
  const record: LifecycleRecord = {
    workflow: input.workflow,
    state: "Draft",
    captureId: input.capture.id,
    studioProfileId: input.studioProfileId,
    canonicalUrl: input.canonicalUrl,
    compilerPayloadSha256: input.capture.compilerPayloadSha256,
    structuralFingerprint: input.capture.fingerprint,
    idempotencyKey: input.idempotencyKey,
    artifactSha256: input.artifactSha256,
    createdAt: now,
    updatedAt: now,
  };
  lifecycleRecords.set(input.workflow.id, record);
  await persistLifecycle(record);
  return record;
}

async function findIdempotentDraft(input: {
  idempotencyKey: string;
  capture: CaptureRecord;
  studioProfileId: StudioProfileId;
  canonicalUrl: string;
  instruction: string;
}) {
  let workflowId: string | undefined;
  try {
    const manifest = JSON.parse(
      await readFile(idempotencyPath(input.idempotencyKey), "utf8"),
    ) as { workflowId?: string };
    workflowId = manifest.workflowId;
  } catch {
    const entries = await listWorkflowArtifacts();
    for (const entry of entries) {
      try {
        const artifact = await readWorkflowArtifact(entry.id);
        let candidateLifecycle = lifecycleRecords.get(entry.id);
        if (!candidateLifecycle && existsSync(lifecyclePath(entry.id))) {
          candidateLifecycle = await loadPersistedLifecycle(entry.id);
        }
        if (
          candidateLifecycle &&
          candidateLifecycle.studioProfileId !== input.studioProfileId
        ) {
          continue;
        }
        if (
          artifactInstruction(artifact.workflow) ===
            normalizeInstructionForIdentity(input.instruction) &&
          canonicalizeTargetUrl(artifact.workflow.source.url) ===
            input.canonicalUrl
        ) {
          workflowId = artifact.workflow.id;
          break;
        }
      } catch {
        // Invalid artifacts are never candidates for reuse.
      }
    }
  }
  if (!workflowId) return null;
  const artifact = await readWorkflowArtifact(workflowId);
  let persisted = lifecycleRecords.get(workflowId);
  if (!persisted && existsSync(lifecyclePath(workflowId))) {
    persisted = await loadPersistedLifecycle(workflowId);
  }
  try {
    validateArtifactAgainstCapture({
      workflow: artifact.workflow,
      capture: input.capture,
      studioProfileId: input.studioProfileId,
      canonicalUrl: input.canonicalUrl,
      persisted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message === "Artifact structural fingerprint is not compatible." ||
      message ===
        "Artifact restoration refused: a selected locator is missing or ambiguous."
    ) {
      return null;
    }
    throw error;
  }
  return createDraftRecord({
    workflow: artifact.workflow,
    capture: input.capture,
    studioProfileId: input.studioProfileId,
    canonicalUrl: input.canonicalUrl,
    idempotencyKey: input.idempotencyKey,
    artifactSha256: artifact.sha256,
  });
}

function studioHtml() {
  const initialDemoUrl = demoUrl(publicDemoUrl, "A");
  const serializedPublicDemoUrl = JSON.stringify(publicDemoUrl).replaceAll(
    "<",
    "\\u003c",
  );
  const serializedStudioProfiles = JSON.stringify(studioProfiles).replaceAll(
    "<",
    "\\u003c",
  );
  const serializedLabModeEnabled = JSON.stringify(labModeEnabled);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#101216">
  <title>Visual Compiler Studio</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #eef2f8; background: #101216; color-scheme: dark; }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { margin: 0; min-width: 0; background: #101216; }
    .app { display: grid; grid-template-columns: minmax(290px, 340px) minmax(420px, 1fr) minmax(330px, 430px); min-height: 100vh; min-height: 100dvh; }
    aside, section { min-width: 0; border-right: 1px solid #2a3039; }
    .left, .right { padding: 18px; overflow: auto; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    h2 { margin: 0 0 12px; font-size: 14px; color: #9facbf; text-transform: uppercase; letter-spacing: .08em; }
    .tagline { color: #9facbf; margin-top: 0; }
    .hint { color: #9facbf; font-size: 13px; line-height: 1.4; margin: 10px 0 0; }
    textarea { display: block; width: 100%; min-height: 156px; resize: vertical; border: 1px solid #3b4555; background: #171b22; color: #f5f7fb; border-radius: 7px; padding: 12px; font: inherit; font-size: 16px; line-height: 1.4; }
    button, select { min-height: 44px; border: 1px solid #3c4858; background: #1d2430; color: #f3f6fb; border-radius: 7px; padding: 10px 12px; font: inherit; font-weight: 700; touch-action: manipulation; }
    button, select, input, textarea { max-width: 100%; min-width: 0; }
    button { cursor: pointer; }
    button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid #65bff3; outline-offset: 2px; }
    button.primary { background: #2f8f68; border-color: #2f8f68; }
    button.secondary { background: #263044; }
    button:disabled { cursor: wait; opacity: .62; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
    .metric { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid #29313c; }
    .metric strong { font-size: 22px; color: #fff; }
    .preview { min-height: 480px; background: #fff; }
    iframe { display: block; width: 100%; height: 100%; min-height: 480px; border: 0; background: white; }
    pre { margin: 0; background: #0b0d10; border: 1px solid #29313c; border-radius: 7px; padding: 12px; overflow: auto; max-height: calc(100dvh - 88px); font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .tabs { display: flex; gap: 6px; margin-bottom: 12px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tabs button { flex: 0 0 auto; min-height: 40px; padding: 7px 9px; font-size: 12px; }
    .ok { color: #64d790; }
    .warn { color: #f0bd59; }
    .error { color: #ff8585; }
    .mode-panel { border: 2px solid #d4a832; border-radius: 9px; padding: 14px; margin: 16px 0; background: #272315; }
    .lab-panel { border: 3px solid #ff9f1c; background: #2c1b08; box-shadow: 0 0 0 2px #101216, 0 0 22px rgba(255,159,28,.22); }
    .lab-banner { display: block; color: #ffd089; font-size: 17px; line-height: 1.25; margin-bottom: 10px; }
    .lab-progress { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin: 10px 0; }
    .lab-progress span { padding: 6px 4px; border: 1px solid #61451f; border-radius: 5px; text-align: center; font-size: 11px; color: #b8a88f; }
    .lab-progress span.active { color: white; background: #965b0c; border-color: #ffb340; }
    .lab-progress span.complete { color: #8cf0b0; border-color: #3f8959; }
    .mode-panel.clinical { border-color: #d75252; background: #2b181b; }
    .mode-title { font-weight: 900; letter-spacing: .08em; }
    .profile-status { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 10px 0; padding: 10px; border-radius: 7px; background: #141820; }
    .profile-status strong { color: #fff; }
    .authentication-state { margin-top: 10px; padding: 10px; border: 1px solid #d4a832; border-radius: 7px; background: #191b20; font-weight: 900; }
    .authentication-state.locked { border-color: #2f8f68; color: #9df1c4; }
    .field { display: grid; gap: 6px; margin-top: 10px; }
    .field select, .field input { width: 100%; }
    .hidden { display: none !important; }
    .attestation { display: grid; gap: 8px; margin-top: 12px; font-size: 13px; }
    .attestation label { display: grid; grid-template-columns: 22px 1fr; gap: 6px; align-items: start; }
    .lifecycle-track { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin: 14px 0; }
    .lifecycle-track span { min-width: 0; padding: 8px 4px; border: 1px solid #4a5361; border-radius: 6px; color: #9facbf; font-size: 12px; text-align: center; overflow-wrap: anywhere; }
    .lifecycle-track span.complete { border-color: #2f8f68; background: #183527; color: #9df1c4; }
    .lifecycle-track span.active { border-color: #65bff3; background: #183246; color: #fff; box-shadow: 0 0 0 2px rgba(101,191,243,.2); }
    .report-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
    .report-grid > div { min-width: 0; }
    .report-grid pre { margin-top: 6px; max-height: 220px; }
    .compiler-preview { margin: 14px 0; padding: 12px; border: 1px solid #65bff3; border-radius: 8px; background: #131a22; }
    .compiler-preview pre { max-height: 360px; margin: 8px 0; }
    .compile-progress { margin: 10px 0; padding-left: 22px; }
    .compile-progress li { color: #778294; margin: 4px 0; }
    .compile-progress li.active { color: #f5c451; font-weight: 700; }
    .compile-progress li.complete { color: #82d49b; }
    input[type="url"] { width: 100%; min-height: 44px; border: 1px solid #3b4555; background: #171b22; color: white; border-radius: 7px; padding: 10px; font-size: 16px; }
    @media (max-width: 980px) {
      .app { grid-template-columns: 1fr; min-height: auto; }
      aside, section { border-right: 0; border-bottom: 1px solid #2a3039; }
      .left, .right { overflow: visible; padding-left: max(18px, env(safe-area-inset-left)); padding-right: max(18px, env(safe-area-inset-right)); }
      .left { padding-top: max(18px, env(safe-area-inset-top)); }
      .right { padding-bottom: max(18px, env(safe-area-inset-bottom)); }
      .preview { height: 68svh; min-height: 460px; }
      iframe { min-height: 460px; }
      pre { max-height: 60svh; }
      .report-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .left, .right { padding-top: 16px; padding-bottom: 16px; }
      .row > select { flex: 1 1 100%; width: 100%; }
      .row > button { flex: 1 1 calc(33.333% - 10px); }
      .metric { font-size: 14px; }
      .metric strong { font-size: 19px; }
      .preview { height: 72svh; min-height: 430px; }
      iframe { min-height: 430px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
  <main class="app">
    <aside class="left">
      <h1>Visual Compiler</h1>
      <p class="tagline">Compile on synthetic data. Execute on real workflows.</p>
      <section class="mode-panel lab-panel hidden" id="labPanel" aria-label="Visual Compiler Lab Mode">
        <strong class="lab-banner">LAB MODE — SYNTHETIC TEST ENVIRONMENT</strong>
        <p class="hint">Fast local prototyping only. Clinical mode remains unavailable.</p>
        <div id="labConfirmation">
          <label><input type="checkbox" id="labSyntheticConfirmation"> I confirm that this session contains only synthetic test records.</label>
          <button type="button" id="confirmLabSession" disabled>Confirm once for this session</button>
        </div>
        <strong id="labConfirmedState" class="ok hidden">CONFIRMATION UNIQUE — session active</strong>
        <div class="lab-progress" id="labProgress" aria-label="Lab progress">
          <span data-lab-stage="Browser">1. Browser</span>
          <span data-lab-stage="Locked">2. Locked</span>
          <span data-lab-stage="Captured">3. Captured</span>
          <span data-lab-stage="Compiled">4. Compiled</span>
          <span data-lab-stage="Ready">5. Ready</span>
          <span data-lab-stage="Running">6. Running</span>
          <span data-lab-stage="Passed">7. Passed</span>
          <span data-lab-stage="Failed">7. Failed</span>
        </div>
        <div class="row">
          <button type="button" id="labCapture" disabled>Capture now</button>
          <button type="button" id="labCompile" aria-label="Lab Compile" disabled>Compile</button>
          <button type="button" id="labRun" disabled>Run on current page</button>
          <button type="button" id="labRunAgain" disabled>Run again</button>
          <button type="button" id="labRecaptureCompile" disabled>Recapture and compile</button>
          <button type="button" id="labStop" disabled>Stop</button>
          <button type="button" id="labReset" disabled>Reset test session</button>
        </div>
        <div class="authentication-state" id="labRuntimePhase" aria-live="polite">Runtime ready — no active action.</div>
        <pre id="labResult">Confirm the synthetic Lab session once to begin.</pre>
      </section>
      <section class="mode-panel" id="activeProfilePanel" aria-label="Active application profile">
        <div class="mode-title">APPLICATION PROFILE</div>
        <label class="field" for="applicationProfile">Managed profile
          <select id="applicationProfile" aria-label="Application profile"></select>
        </label>
        <div class="profile-status" aria-live="polite">
          <span>Active profile</span><strong id="activeProfileId">ncba-dpi-fixture</strong>
          <span>Active mode</span><strong id="activeMode">TRAINING</strong>
        </div>
        <strong id="profileWarning">SYNTHETIC DATA ONLY — LOCAL FIXTURE.</strong>
        <label class="field" id="targetUrlField" for="targetUrl">Target Website URL
          <input id="targetUrl" type="url" autocomplete="off">
        </label>
        <button type="button" id="openManagedBrowser" disabled>Open in managed browser</button>
        <p class="hint warn" id="targetValidation" aria-live="polite">Validating configured target locally…</p>
        <p class="hint" id="openPolicy">Selecting a profile never opens its URL. Opening requires this explicit action.</p>
        <div class="authentication-state hidden" id="authenticationState" aria-live="polite">AUTHENTICATION NOT STARTED — capture and compilation disabled</div>
        <button type="button" class="hidden" id="lockManagedBrowser" disabled>Authentication complete — lock to application</button>
        <div class="attestation" id="syntheticAttestation" aria-label="Synthetic data attestation">
          <strong>I confirm that:</strong>
          <label><input type="checkbox" data-attestation-key="authorizedTrainingEnvironment"> <span>I am authorized to automate this training environment.</span></label>
          <label><input type="checkbox" data-attestation-key="syntheticDataOnly"> <span>Synthetic environment — no patient data.</span></label>
          <label><input type="checkbox" data-attestation-key="noRealPatientDataVisible"> <span>No real patient data is visible.</span></label>
          <label><input type="checkbox" data-attestation-key="noCredentialOrSecretSentToOpenAI"> <span>No credential, cookie, token, form value, browser storage, or network data may be sent to OpenAI.</span></label>
          <label><input type="checkbox" data-attestation-key="administrativeAndReversible"> <span>The workflow is administrative and reversible.</span></label>
          <label><input type="checkbox" id="indicatorVerified"> <span>I verified the synthetic marker locally.</span></label>
          <label class="field" for="syntheticIndicator">Verified marker
            <select id="syntheticIndicator">
              <option value="training-banner">Training banner</option>
              <option value="demo-account">Demo account</option>
              <option value="test-tenant">Test tenant</option>
              <option value="test-record">TEST record</option>
              <option value="institution-approved-marker">Institution-approved marker</option>
            </select>
          </label>
        </div>
      </section>
      <section id="trainingControls" aria-label="Training Compilation">
        <h2>Instruction</h2>
        <textarea id="instruction" aria-label="Workflow instruction">${escapeHtml(DEFAULT_INSTRUCTION)}</textarea>
        <div class="row">
          <select id="workflow" aria-label="Compiled workflow"></select>
          <select id="variant" aria-label="Demo layout"><option value="A">Variant A</option><option value="B">Variant B</option></select>
          <button class="secondary" id="capture">Capture</button>
          <button class="primary" id="compile" disabled>Compile</button>
          <button class="secondary" id="runA">Run A</button>
          <button class="secondary" id="runB">Run B</button>
        </div>
        <p class="hint">Capture and compilation remain closed until every attestation control is checked. Run A/B replays only the local Build Week fixture.</p>
        <div class="compiler-preview" aria-label="Redacted compiler payload review">
          <strong>Exact redacted payload preview</strong>
          <p class="hint">Only this canonical, classified semantic payload may cross the compiler boundary. Form values, query parameters, storage, cookies, headers and network data are excluded.</p>
          <pre id="compilerPayloadPreview">Capture required.</pre>
          <label><input type="checkbox" id="compilerPayloadConfirmation" disabled> I reviewed this exact redacted payload and confirm that it contains synthetic interface semantics only.</label>
          <ol class="compile-progress" id="compileProgress" aria-label="Compilation progress"></ol>
          <strong>Locator diagnostics</strong>
          <pre id="locatorDiagnostics">Compilation required.</pre>
          <label><input type="checkbox" id="restoreArtifactConfirmation" disabled> I confirm restoration of the selected compatible artifact as Draft without GPT.</label>
          <button type="button" class="secondary" id="restoreDraft" disabled>Restore compatible Draft</button>
        </div>
      </section>
      <section class="mode-panel hidden" id="trainingExecutionPanel" aria-label="Locked Training execution">
        <div class="mode-title">LOCKED TRAINING TEST</div>
        <strong class="warn">Training synthetic data only</strong>
        <p class="hint">This test uses the already open, authenticated and application-locked Playwright page. It never opens another browser and never calls OpenAI.</p>
        <div class="lifecycle-track" aria-label="Training workflow lifecycle">
          <span data-training-lifecycle-state="Draft">Draft</span>
          <span data-training-lifecycle-state="Validated">Validated</span>
          <span data-training-lifecycle-state="Approved">Approved</span>
          <span data-training-lifecycle-state="Promoted">Promoted</span>
          <span data-training-lifecycle-state="Revoked">Revoked</span>
        </div>
        <button type="button" class="secondary" id="trainingExecutionPreflight" disabled>Prepare Training test preflight</button>
        <strong>Planned actions and selected locators</strong>
        <pre id="trainingPlannedActions">Preflight required.</pre>
        <strong>Training preflight result</strong>
        <pre id="trainingExecutionPreflightResult">Preflight required.</pre>
        <label><input type="checkbox" id="trainingExecutionConfirmation" disabled> I confirm execution on the currently displayed synthetic Training record.</label>
        <button type="button" class="primary" id="runLockedTraining" disabled>Test run on locked Training page</button>
        <strong>Redacted Training telemetry</strong>
        <pre id="trainingExecutionTelemetry">Runtime LLM calls: 0
OpenAI requests: 0</pre>
      </section>
      <section class="mode-panel" id="fixtureLifecyclePanel" aria-label="Fixture workflow lifecycle">
        <div class="mode-title">FIXTURE WORKFLOW JOURNEY</div>
        <div class="lifecycle-track" aria-label="Workflow lifecycle">
          <span data-lifecycle-state="Draft">Draft</span>
          <span data-lifecycle-state="Validated">Validated</span>
          <span data-lifecycle-state="Approved">Approved</span>
          <span data-lifecycle-state="Promoted">Promoted</span>
          <span data-lifecycle-state="Revoked">Revoked</span>
        </div>
        <div class="row">
          <button type="button" id="validateWorkflow" disabled>Validate A/B</button>
          <label><input type="checkbox" id="approvalConfirmation"> Human approval confirmed</label>
          <button type="button" id="approveWorkflow" disabled>Approve</button>
          <button type="button" id="promoteWorkflow" disabled>Promote</button>
          <button type="button" id="revokeWorkflow" disabled>Revoke</button>
        </div>
        <div class="report-grid">
          <div><strong>Redaction report</strong><pre id="redactionReport">Capture required.</pre></div>
          <div><strong>Structural fingerprint</strong><pre id="fingerprintReport">Capture required.</pre></div>
          <div><strong>Preflight result</strong><pre id="preflightReport">Promotion required.</pre></div>
        </div>
        <label><input type="checkbox" id="preflightConfirmation"> I reviewed the planned actions and confirm preflight.</label>
        <div class="row">
          <button type="button" id="fixturePreflight" disabled>Run preflight</button>
          <button type="button" id="runPromotedA" disabled>Execute promoted A</button>
          <button type="button" id="runPromotedB" disabled>Execute promoted B</button>
        </div>
        <pre id="fixtureRuntimeResult">Runtime LLM calls: 0
OpenAI requests: 0</pre>
      </section>
      <section class="mode-panel clinical hidden" id="clinicalPanel" aria-label="Clinical Runtime">
        <div class="mode-title">CLINICAL RUNTIME</div>
        <strong>OPENAI ACCESS FORBIDDEN</strong><br><strong>PROMOTED WORKFLOWS ONLY</strong>
        <label for="promotedWorkflow">Promoted workflow</label>
        <select id="promotedWorkflow" aria-label="Promoted workflow"><option>No promoted NCBA workflow</option></select>
        <p class="hint" id="clinicalMetrics">Hash verification: pending<br>Structural compatibility: pending<br>Runtime LLM calls: 0<br>OpenAI requests: 0</p>
        <pre id="clinicalPreflightResult" aria-label="Planned clinical actions">No actions — preflight required.</pre>
        <label><input type="checkbox" id="clinicalConfirmation"> I reviewed the planned reversible administrative actions.</label>
        <button type="button" id="clinicalPreflight">Preflight</button>
        <button type="button" id="clinicalRun" disabled>Run promoted workflow</button>
        <button type="button" id="clinicalStop">Emergency Stop</button>
        <button type="button" id="deleteClinicalProfile">Delete local clinical browser profile</button>
        <p class="hint">Redacted local audit is created only after an authorized promoted run. Compilation is not exposed in this mode.</p>
      </section>
      <div style="margin-top:18px" aria-live="polite">
        <div class="metric"><span>Compile-time model calls</span><strong id="compileCalls">0</strong></div>
        <div class="metric"><span>Compile response model</span><strong id="compileModel">-</strong></div>
        <div class="metric"><span>Compile tokens (in / out)</span><strong id="compileTokens">-</strong></div>
        <div class="metric"><span>Runtime model calls</span><strong id="runtimeCalls">0</strong></div>
        <div class="metric"><span>Selected locator confidence</span><strong id="confidence">-</strong></div>
        <div class="metric"><span>Status</span><strong id="status" class="warn">Idle</strong></div>
      </div>
    </aside>
    <section class="preview" aria-label="Demo preview">
      <iframe id="demo" title="Controlled workflow demo" src="${escapeHtml(initialDemoUrl)}"></iframe>
    </section>
    <aside class="right">
      <div class="tabs" role="tablist" aria-label="Workflow details">
        <button role="tab" data-tab="ir">Semantic IR</button>
        <button role="tab" data-tab="locators">Locators</button>
        <button role="tab" data-tab="code">Playwright</button>
        <button role="tab" data-tab="log">Runtime log</button>
      </div>
      <pre id="output" tabindex="0">No workflow loaded.</pre>
    </aside>
  </main>
  <script>
    const publicDemoUrl = ${serializedPublicDemoUrl};
    const studioProfiles = ${serializedStudioProfiles};
    const labModeEnabled = ${serializedLabModeEnabled};
    const state = {
      workflow: null,
      telemetry: null,
      tab: "ir",
      profile: studioProfiles[0],
      capture: null,
      lifecycle: null,
      preflight: null,
      targetValid: false,
      authenticationPhase: "idle",
      canLockAuthentication: false,
      compileInFlight: false,
      trainingExecutionPreflight: null,
      labSessionToken: null,
      labRunCompleted: false,
      labRunning: false,
      labPreparing: false,
      labStage: "Browser"
    };
    const output = document.getElementById("output");
    const workflowSelect = document.getElementById("workflow");
    const profileSelect = document.getElementById("applicationProfile");
    const targetUrl = document.getElementById("targetUrl");
    const compileButton = document.getElementById("compile");
    const captureButton = document.getElementById("capture");
    const attestationInputs = Array.from(document.querySelectorAll("[data-attestation-key]"));
    const indicatorVerified = document.getElementById("indicatorVerified");
    const compilerPayloadConfirmation = document.getElementById("compilerPayloadConfirmation");
    const restoreArtifactConfirmation = document.getElementById("restoreArtifactConfirmation");
    const trainingExecutionConfirmation = document.getElementById("trainingExecutionConfirmation");
    const compileStages = ${JSON.stringify(compileProgressStages)};
    const controls = Array.from(document.querySelectorAll("button, select, input, textarea"));
    let targetValidationTimer;
    let authenticationPollTimer;
    const variantUrl = variant => publicDemoUrl + "/demo?variant=" + variant;
    const lifecycleOrder = ["Draft", "Validated", "Approved", "Promoted", "Revoked"];
    const labActive = () =>
      labModeEnabled &&
      Boolean(state.labSessionToken) &&
      state.profile.mode !== "clinical";
    const attestationComplete = () =>
      labActive() ||
      (attestationInputs.every(input => input.checked) && indicatorVerified.checked);
    const syncJourneyControls = () => {
      const fixture = state.profile.id === "ncba-dpi-fixture";
      const attested = attestationComplete();
      const lifecycleState = state.lifecycle?.state;
      const managedApplicationReady =
        !state.profile.managedBrowserOnly ||
        state.authenticationPhase === "application-locked";
      document.getElementById("openManagedBrowser").disabled =
        !state.targetValid ||
        (state.profile.syntheticAttestationRequired && !attested);
      captureButton.disabled =
        state.profile.mode === "clinical" ||
        !state.profile.captureAllowed ||
        !attested ||
        !state.targetValid ||
        !managedApplicationReady;
      compileButton.disabled =
        state.compileInFlight ||
        state.profile.mode === "clinical" ||
        !state.profile.compilationAllowed ||
        !attested ||
        !state.targetValid ||
        !managedApplicationReady ||
        !state.capture ||
        !compilerPayloadConfirmation.checked;
      restoreArtifactConfirmation.disabled =
        state.compileInFlight ||
        state.profile.mode === "clinical" ||
        !state.capture ||
        !workflowSelect.value;
      document.getElementById("restoreDraft").disabled =
        restoreArtifactConfirmation.disabled ||
        !restoreArtifactConfirmation.checked;
      document.getElementById("lockManagedBrowser").disabled =
        !state.canLockAuthentication ||
        state.authenticationPhase !== "authentication-bootstrap";
      document.getElementById("runA").disabled = !fixture;
      document.getElementById("runB").disabled = !fixture;
      document.getElementById("validateWorkflow").disabled = !fixture || lifecycleState !== "Draft";
      document.getElementById("approveWorkflow").disabled =
        !fixture ||
        lifecycleState !== "Validated" ||
        !document.getElementById("approvalConfirmation").checked;
      document.getElementById("promoteWorkflow").disabled = !fixture || lifecycleState !== "Approved";
      document.getElementById("revokeWorkflow").disabled = !fixture || lifecycleState !== "Promoted";
      document.getElementById("fixturePreflight").disabled =
        !fixture ||
        lifecycleState !== "Promoted" ||
        !document.getElementById("preflightConfirmation").checked;
      document.getElementById("runPromotedA").disabled =
        !fixture || lifecycleState !== "Promoted" || !state.preflight?.allowed;
      document.getElementById("runPromotedB").disabled =
        !fixture || lifecycleState !== "Promoted" || !state.preflight?.allowed;
      document.getElementById("clinicalPreflight").disabled =
        state.profile.mode !== "clinical" ||
        !state.lifecycle?.promotion ||
        !document.getElementById("clinicalConfirmation").checked;
      document.getElementById("clinicalRun").disabled =
        state.profile.mode !== "clinical" ||
        state.lifecycle?.state !== "Promoted" ||
        !state.preflight?.allowed;
      document.getElementById("trainingExecutionPreflight").disabled =
        state.profile.id !== "ncba-dpi-training" ||
        state.authenticationPhase !== "application-locked" ||
        lifecycleState !== "Draft" ||
        !state.capture ||
        !state.workflow;
      trainingExecutionConfirmation.disabled =
        !state.trainingExecutionPreflight;
      document.getElementById("runLockedTraining").disabled =
        state.profile.id !== "ncba-dpi-training" ||
        state.authenticationPhase !== "application-locked" ||
        lifecycleState !== "Draft" ||
        !state.trainingExecutionPreflight ||
        !trainingExecutionConfirmation.checked;
      const labReady =
        labActive() &&
        state.profile.mode !== "clinical" &&
        managedApplicationReady;
      const labExistingPageReady =
        labReady &&
        state.profile.id === "ncba-dpi-training" &&
        state.authenticationPhase === "application-locked";
      document.getElementById("labCapture").disabled = !labReady;
      document.getElementById("labCompile").disabled =
        !labReady || state.compileInFlight || state.labRunning || state.labPreparing;
      document.getElementById("labRecaptureCompile").disabled =
        !labReady || state.compileInFlight || state.labRunning || state.labPreparing;
      document.getElementById("labRun").disabled =
        !labExistingPageReady ||
        state.labRunning ||
        !state.workflow ||
        !["Draft", "Validated"].includes(lifecycleState);
      document.getElementById("labRunAgain").disabled =
        !labExistingPageReady ||
        state.labRunning ||
        !state.labRunCompleted ||
        !state.workflow;
      document.getElementById("labStop").disabled = !state.labRunning;
      document.getElementById("labReset").disabled = !labActive();
    };
    const setBusy = busy => {
      controls.forEach(control => { control.disabled = busy; });
      if (!busy) syncJourneyControls();
    };
    const setStatus = (text, cls = "warn") => { const el = document.getElementById("status"); el.textContent = text; el.className = cls; };
    const setLabStage = stage => {
      state.labStage = stage;
      const order = ["Browser", "Locked", "Captured", "Compiled", "Ready", "Running", "Passed"];
      const currentIndex = order.indexOf(stage);
      document.querySelectorAll("[data-lab-stage]").forEach(node => {
        const index = order.indexOf(node.dataset.labStage);
        node.classList.toggle("active", node.dataset.labStage === stage);
        node.classList.toggle(
          "complete",
          currentIndex >= 0 && index >= 0 && index < currentIndex
        );
      });
    };
    const syntheticAttestation = () => ({
      profileId: state.profile.applicationProfileId,
      statements: Object.fromEntries(
        attestationInputs.map(input => [input.dataset.attestationKey, input.checked])
      ),
      syntheticIndicator: document.getElementById("syntheticIndicator").value,
      indicatorVerifiedLocally: indicatorVerified.checked,
      attestedAt: new Date().toISOString()
    });
    const resetAttestation = () => {
      attestationInputs.forEach(input => { input.checked = false; });
      indicatorVerified.checked = false;
      syncJourneyControls();
    };
    const resetCapture = () => {
      state.capture = null;
      state.trainingExecutionPreflight = null;
      trainingExecutionConfirmation.checked = false;
      trainingExecutionConfirmation.disabled = true;
      document.getElementById("trainingPlannedActions").textContent = "Preflight required.";
      document.getElementById("trainingExecutionPreflightResult").textContent = "Preflight required.";
      document.getElementById("trainingExecutionTelemetry").textContent =
        "Runtime LLM calls: 0\\nOpenAI requests: 0";
      compilerPayloadConfirmation.checked = false;
      compilerPayloadConfirmation.disabled = true;
      restoreArtifactConfirmation.checked = false;
      restoreArtifactConfirmation.disabled = true;
      document.getElementById("compilerPayloadPreview").textContent = "Capture required.";
      document.getElementById("locatorDiagnostics").textContent = "Compilation required.";
      document.getElementById("compileProgress").replaceChildren();
      document.getElementById("redactionReport").textContent = "Capture required.";
      document.getElementById("fingerprintReport").textContent = "Capture required.";
      syncJourneyControls();
    };
    const validateTargetInput = async () => {
      state.targetValid = false;
      const validation = document.getElementById("targetValidation");
      validation.textContent = "Validating target locally — no navigation performed…";
      validation.className = "hint warn";
      syncJourneyControls();
      try {
        const result = await requestJson("/api/target/validate", {
          studioProfileId: state.profile.id,
          targetUrl: targetUrl.value
        });
        state.targetValid = result.accepted === true;
        validation.textContent =
          "Target accepted: " + result.canonicalUrl +
          (result.queryParametersDiscarded
            ? " — query parameters will remain memory-only and will be removed from logs and artifacts."
            : " — no query parameters.");
        validation.className = "hint ok";
        if (state.profile.id === "ncba-dpi-fixture") {
          document.getElementById("demo").src = targetUrl.value;
        }
      } catch {
        validation.textContent = "Target rejected by the active Application Profile.";
        validation.className = "hint error";
      } finally {
        syncJourneyControls();
      }
    };
    const renderAuthenticationState = authentication => {
      state.authenticationPhase = authentication.phase ?? "idle";
      state.canLockAuthentication = authentication.canLock === true;
      const panel = document.getElementById("authenticationState");
      panel.classList.toggle("hidden", !state.profile.managedBrowserOnly);
      panel.classList.toggle(
        "locked",
        state.authenticationPhase === "application-locked"
      );
      if (state.authenticationPhase === "authentication-bootstrap") {
        panel.textContent =
          "AUTHENTICATION IN PROGRESS — capture and compilation disabled" +
          (authentication.currentOrigin
            ? " — current origin: " + authentication.currentOrigin
            : "") +
          (state.canLockAuthentication
            ? " — application origin detected; locking is available."
            : "");
      } else if (state.authenticationPhase === "application-locked") {
        panel.textContent =
          "APPLICATION LOCKED — capture and compilation enabled — main-page origin enforced.";
      } else {
        panel.textContent =
          "AUTHENTICATION NOT STARTED — capture and compilation disabled";
      }
      document.getElementById("lockManagedBrowser").classList.toggle(
        "hidden",
        !state.profile.managedBrowserOnly ||
          state.authenticationPhase === "application-locked"
      );
      syncJourneyControls();
    };
    const pollAuthenticationStatus = async () => {
      window.clearTimeout(authenticationPollTimer);
      if (!state.profile.managedBrowserOnly) return;
      try {
        const response = await fetch(
          "/api/managed-browser/status/" +
            encodeURIComponent(state.profile.id)
        );
        if (response.ok) renderAuthenticationState(await response.json());
      } finally {
        if (state.authenticationPhase === "authentication-bootstrap") {
          authenticationPollTimer = window.setTimeout(
            pollAuthenticationStatus,
            750
          );
        }
      }
    };
    const renderLifecycle = () => {
      const current = state.lifecycle?.state;
      const currentIndex = lifecycleOrder.indexOf(current);
      document.querySelectorAll("[data-lifecycle-state]").forEach(node => {
        const index = lifecycleOrder.indexOf(node.dataset.lifecycleState);
        node.classList.toggle("active", node.dataset.lifecycleState === current);
        node.classList.toggle("complete", currentIndex >= 0 && index < currentIndex);
      });
      document.querySelectorAll("[data-training-lifecycle-state]").forEach(node => {
        const index = lifecycleOrder.indexOf(node.dataset.trainingLifecycleState);
        node.classList.toggle("active", node.dataset.trainingLifecycleState === current);
        node.classList.toggle("complete", currentIndex >= 0 && index < currentIndex);
      });
      const promotedSelect = document.getElementById("promotedWorkflow");
      if (state.lifecycle?.promotion && state.workflow) {
        const option = document.createElement("option");
        option.value = state.workflow.id;
        option.textContent = state.workflow.name + " — " + state.lifecycle.state;
        promotedSelect.replaceChildren(option);
      } else {
        const option = document.createElement("option");
        option.textContent = "No promoted NCBA workflow";
        promotedSelect.replaceChildren(option);
      }
      syncJourneyControls();
    };
    const renderProfile = profile => {
      state.profile = profile;
      document.getElementById("activeProfileId").textContent = profile.id;
      document.getElementById("activeMode").textContent =
        profile.id === "ncba-dpi-fixture" ? "FIXTURE" : profile.mode.toUpperCase();
      document.getElementById("profileWarning").textContent = profile.warning;
      targetUrl.value = profile.defaultUrl;
      targetUrl.readOnly = !profile.urlEditable;
      state.targetValid = false;
      window.clearTimeout(authenticationPollTimer);
      renderAuthenticationState({ phase: "idle", canLock: false });
      document.getElementById("syntheticAttestation").classList.toggle("hidden", !profile.syntheticAttestationRequired);
      document.getElementById("labPanel").classList.toggle(
        "hidden",
        !labModeEnabled || profile.mode === "clinical"
      );
      document.getElementById("labConfirmation").classList.toggle(
        "hidden",
        labActive()
      );
      document.getElementById("labConfirmedState").classList.toggle(
        "hidden",
        !labActive()
      );
      document.getElementById("syntheticAttestation").classList.toggle(
        "hidden",
        !profile.syntheticAttestationRequired || labActive()
      );
      document.getElementById("trainingControls").classList.toggle("hidden", profile.mode === "clinical");
      document.getElementById("trainingExecutionPanel").classList.toggle(
        "hidden",
        profile.id !== "ncba-dpi-training" || labActive()
      );
      document.getElementById("fixtureLifecyclePanel").classList.toggle("hidden", profile.id !== "ncba-dpi-fixture");
      document.getElementById("clinicalPanel").classList.toggle("hidden", profile.mode !== "clinical");
      document.getElementById("activeProfilePanel").classList.toggle("clinical", profile.mode === "clinical");
      resetAttestation();
      resetCapture();
      const frame = document.getElementById("demo");
      if (profile.id === "ncba-dpi-fixture") {
        frame.removeAttribute("srcdoc");
        frame.src = profile.defaultUrl;
      } else {
        frame.removeAttribute("src");
        frame.srcdoc = "<!doctype html><title>Manual opening required</title><style>body{font:16px system-ui;padding:32px;color:#18202b}strong{display:block;margin-bottom:12px}</style><strong>Manual opening required</strong><p>Studio will not contact this profile URL automatically. Use Open in managed browser after verifying authorization and mode.</p>";
      }
      setStatus(profile.mode === "clinical" ? "Clinical execution-only profile" : "Training profile selected");
      renderLifecycle();
      validateTargetInput();
      if (profile.managedBrowserOnly) pollAuthenticationStatus();
    };
    const showWorkflowMetrics = workflow => {
      document.getElementById("compileCalls").textContent = workflow.diagnostics.modelCalls;
      document.getElementById("compileModel").textContent =
        workflow.diagnostics.interpretationSource === "mock"
          ? "offline-mock (no model served)"
          : workflow.diagnostics.responseModel ?? workflow.compileModel;
      const usage = workflow.diagnostics.tokenUsage;
      document.getElementById("compileTokens").textContent = usage ? usage.inputTokens + " / " + usage.outputTokens : "-";
      document.getElementById("confidence").textContent = Math.round(workflow.steps[0].selectedLocator.confidence * 100) + "%";
    };
    const applyWorkflow = workflow => {
      state.workflow = workflow;
      showWorkflowMetrics(workflow);
      setStatus("Artifact loaded", "ok");
      render();
    };
    const summarizedWorkflowDiagnostics = workflow => ({
      modelCalls: workflow.diagnostics.modelCalls,
      interpretationSource: workflow.diagnostics.interpretationSource,
      responseModel: workflow.diagnostics.responseModel,
      tokenUsage: workflow.diagnostics.tokenUsage,
      durationMs: workflow.diagnostics.durationMs,
      rejected: workflow.diagnostics.rejected,
      locatorDiagnostics: workflow.diagnostics.locatorDiagnostics
    });
    const workflowDisplaySummary = workflow => ({
      workflowId: workflow.id,
      version: workflow.version,
      name: workflow.name,
      source: workflow.source,
      stepCount: workflow.steps.length,
      steps: workflow.steps.map(step => ({
        id: step.id,
        action: step.action,
        intent: step.intent,
        candidateCount: step.candidates.length,
        selectedLocator: step.selectedLocator,
        preconditions: step.preconditions,
        postconditions: step.postconditions
      })),
      compiledAt: workflow.compiledAt,
      compileModel: workflow.compileModel,
      diagnostics: summarizedWorkflowDiagnostics(workflow)
    });
    const fetchJsonWithTimeout = async (url, options = {}, timeoutMs = 30_000) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const json = await response.json();
        if (!response.ok) {
          throw Object.assign(new Error(json.error ?? "Request failed."), {
            response: json
          });
        }
        return json;
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error("Request timed out after " + timeoutMs + " ms.");
        }
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    };
    const refreshWorkflowList = async preferredId => {
      const json = await fetchJsonWithTimeout("/api/workflows");
      workflowSelect.replaceChildren(
        ...json.workflows.map(workflow => {
          const option = document.createElement("option");
          option.value = workflow.id;
          option.textContent = workflow.name;
          return option;
        })
      );
      const selectedId = json.workflows.some(workflow => workflow.id === preferredId)
        ? preferredId
        : json.workflows[0]?.id;
      if (selectedId) workflowSelect.value = selectedId;
      return selectedId;
    };
    const loadWorkflow = async workflowId => {
      if (!workflowId) return;
      state.trainingExecutionPreflight = null;
      trainingExecutionConfirmation.checked = false;
      trainingExecutionConfirmation.disabled = true;
      document.getElementById("trainingPlannedActions").textContent = "Preflight required.";
      document.getElementById("trainingExecutionPreflightResult").textContent = "Preflight required.";
      const workflow = await fetchJsonWithTimeout(
        "/api/workflow?id=" + encodeURIComponent(workflowId)
      );
      applyWorkflow(workflow);
      try {
        state.lifecycle = (
          await fetchJsonWithTimeout(
            "/api/workflow-lifecycle?id=" + encodeURIComponent(workflowId)
          )
        ).lifecycle;
      } catch {
        state.lifecycle = null;
      }
      renderLifecycle();
      return workflow;
    };
    const render = () => {
      if (!state.workflow) { output.textContent = "No workflow loaded."; return; }
      if (state.tab === "ir") output.textContent = JSON.stringify(workflowDisplaySummary(state.workflow), null, 2);
      if (state.tab === "locators") output.textContent = JSON.stringify(state.workflow.steps.map(s => ({ id: s.id, intent: s.intent, candidateCount: s.candidates.length, selectedLocator: s.selectedLocator })), null, 2);
      if (state.tab === "code") output.textContent = state.workflow.generatedPlaywright;
      if (state.tab === "log") output.textContent = JSON.stringify(state.telemetry ?? { message: "Run workflow to collect telemetry." }, null, 2);
      document.querySelectorAll("[data-tab]").forEach(button => button.setAttribute("aria-selected", String(button.dataset.tab === state.tab)));
    };
    const requestJson = async (url, body, options = {}) => {
      const timeoutMs = options.timeoutMs ?? 30_000;
      return fetchJsonWithTimeout(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        },
        timeoutMs
      );
    };
    const renderCompileProgress = progress => {
      const activeIndex = compileStages.indexOf(progress.stage);
      document.getElementById("compileProgress").replaceChildren(
        ...compileStages.map((stage, index) => {
          const item = document.createElement("li");
          item.textContent = stage;
          if (progress.complete || index < activeIndex) item.className = "complete";
          else if (index === activeIndex) item.className = "active";
          return item;
        })
      );
    };
    const pollCompileProgress = async requestId => {
      while (state.compileInFlight) {
        try {
          const response = await fetch("/api/compile-status?id=" + encodeURIComponent(requestId));
          if (response.ok) {
            const progress = await response.json();
            renderCompileProgress(progress);
            setStatus(progress.stage, progress.error ? "error" : "warn");
            if (progress.complete || progress.error) return;
          }
        } catch {
          // The POST request owns the final timeout/error path.
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
      }
    };
    document.querySelectorAll("[data-tab]").forEach(btn => btn.addEventListener("click", () => { state.tab = btn.dataset.tab; render(); }));
    document.getElementById("variant").addEventListener("change", event => {
      if (state.profile.id === "ncba-dpi-fixture") {
        document.getElementById("demo").src = variantUrl(event.target.value);
      }
    });
    const applyCaptureResult = json => {
      state.capture = json;
      compilerPayloadConfirmation.checked = labActive();
      compilerPayloadConfirmation.disabled = labActive();
      document.getElementById("compilerPayloadPreview").textContent =
        JSON.stringify(json.compilerPayload, null, 2);
      document.getElementById("redactionReport").textContent = JSON.stringify({
        ...json.redactionReport,
        compilerBoundary: json.compilerBoundaryReport,
        cookiesCaptured: false,
        storageCaptured: false,
        networkCaptured: false,
        capturedValuesReturned: json.capturedValuesReturned
      }, null, 2);
      document.getElementById("fingerprintReport").textContent = JSON.stringify({
        version: json.structuralFingerprint.version,
        sha256: json.structuralFingerprint.sha256,
        requiredElements: json.structuralFingerprint.requiredElements
      }, null, 2);
      if (labActive()) setLabStage("Captured");
    };
    const captureCurrentPage = async () => {
      const json = await requestJson("/api/capture", {
          studioProfileId: state.profile.id,
          targetUrl: targetUrl.value,
          syntheticAttestation: syntheticAttestation(),
          labSessionToken: state.labSessionToken
        });
      applyCaptureResult(json);
      return json;
    };
    document.getElementById("capture").addEventListener("click", async () => {
      setBusy(true);
      setStatus("Capturing redacted page model");
      try {
        await captureCurrentPage();
        setStatus("Redacted capture ready", "ok");
      } catch (error) {
        state.capture = null;
        setStatus("Capture failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    const compileCurrentInstruction = async (forceNewCompilation = false) => {
      if (state.compileInFlight) return;
      state.compileInFlight = true;
      setBusy(true);
      const requestId = crypto.randomUUID();
      renderCompileProgress({ stage: compileStages[0], complete: false });
      setStatus(compileStages[0]);
      void pollCompileProgress(requestId);
      try {
        const variant = document.getElementById("variant").value;
        const json = await requestJson("/api/compile", {
          requestId,
          instruction: document.getElementById("instruction").value,
          variant,
          studioProfileId: state.profile.id,
          targetUrl: targetUrl.value,
          captureId: state.capture?.captureId,
          compilerPayloadConfirmed: compilerPayloadConfirmation.checked,
          compilerPayloadSha256: state.capture?.compilerPayloadSha256,
          syntheticAttestation: syntheticAttestation(),
          labSessionToken: state.labSessionToken,
          forceNewCompilation
        }, { timeoutMs: ${COMPILE_RESPONSE_TIMEOUT_MS} });
        await refreshWorkflowList(json.workflowId);
        await loadWorkflow(json.workflowId);
        state.lifecycle = json.lifecycle;
        state.preflight = null;
        document.getElementById("locatorDiagnostics").textContent =
          JSON.stringify(json.diagnostics.locatorDiagnostics, null, 2);
        renderCompileProgress({ stage: "Compilation complete", complete: true });
        renderLifecycle();
        setStatus(
          json.reused
            ? "Compatible artifact restored — Draft"
            : "Compilation complete — Draft",
          "ok"
        );
        if (labActive()) {
          state.labRunCompleted = false;
          setLabStage("Ready");
          document.getElementById("labResult").textContent = JSON.stringify({
            status: json.reused
              ? "Compatible artifact reused — no model call"
              : "Compilation complete",
            requestedModel: state.workflow.compileModel,
            servedModel:
              state.workflow.diagnostics.interpretationSource === "mock"
                ? "offline-mock (no model served)"
                : state.workflow.diagnostics.responseModel ?? state.workflow.compileModel,
            tokenUsage: state.workflow.diagnostics.tokenUsage ?? null,
            durationMs: state.workflow.diagnostics.durationMs,
            reused: json.reused,
            modelCalls: state.workflow.diagnostics.modelCalls
          }, null, 2);
        }
      } catch (error) {
        setStatus("Failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        state.compileInFlight = false;
        setBusy(false);
      }
    };
    document.getElementById("compile").addEventListener("click", () => compileCurrentInstruction(false));
    document.getElementById("restoreDraft").addEventListener("click", async () => {
      if (state.compileInFlight) return;
      state.compileInFlight = true;
      setBusy(true);
      setStatus("Validating artifact compatibility");
      try {
        const json = await requestJson("/api/workflows/restore-draft", {
          workflowId: workflowSelect.value,
          studioProfileId: state.profile.id,
          targetUrl: targetUrl.value,
          captureId: state.capture?.captureId,
          compilerPayloadSha256: state.capture?.compilerPayloadSha256,
          restoreConfirmed: restoreArtifactConfirmation.checked,
          instruction: document.getElementById("instruction").value,
          syntheticAttestation: syntheticAttestation()
        });
        await loadWorkflow(json.workflowId);
        state.lifecycle = json.lifecycle;
        state.preflight = null;
        document.getElementById("locatorDiagnostics").textContent =
          JSON.stringify(json.diagnostics.locatorDiagnostics, null, 2);
        renderLifecycle();
        setStatus("Compatible artifact restored — Draft", "ok");
      } catch (error) {
        setStatus("Artifact restoration refused", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        state.compileInFlight = false;
        setBusy(false);
      }
    });
    async function run(variant) {
      setBusy(true);
      setStatus("Opening visible Chromium");
      document.getElementById("demo").src = variantUrl(variant);
      try {
        const json = await requestJson("/api/run", { variant, visible: true, workflowId: workflowSelect.value });
        state.telemetry = json.telemetry;
        document.getElementById("runtimeCalls").textContent = state.telemetry.llmCalls;
        setStatus("Visible replay passed", "ok");
      } catch (error) {
        state.telemetry = error.response ?? { error: error.message };
        setStatus("Failed", "error");
      } finally {
        state.tab = "log";
        render();
        setBusy(false);
      }
    }
    document.getElementById("runA").addEventListener("click", () => run("A"));
    document.getElementById("runB").addEventListener("click", () => run("B"));
    document.getElementById("trainingExecutionPreflight").addEventListener("click", async () => {
      setBusy(true);
      setStatus("Checking locked Training page");
      state.trainingExecutionPreflight = null;
      trainingExecutionConfirmation.checked = false;
      try {
        const json = await requestJson("/api/training/preflight", {
          studioProfileId: state.profile.id,
          workflowId: state.workflow?.id
        });
        state.trainingExecutionPreflight = json;
        document.getElementById("trainingPlannedActions").textContent =
          JSON.stringify(
            json.plannedActions.map((step, index) => ({
              actionNumber: index + 1,
              stepId: step.stepId,
              action: step.action,
              target: step.target,
              selectedLocator: step.selectedLocator,
              value: step.value,
              locatorStrategy: step.locator.strategy,
              locatorMatchCount: step.locator.matchCount,
              selectedLocatorUnique: step.locator.unique
            })),
            null,
            2
          );
        document.getElementById("trainingExecutionPreflightResult").textContent =
          JSON.stringify({
            warning: json.warning,
            ...json.result,
            llmCalls: json.llmCalls,
            openAIRequests: json.openAIRequests
          }, null, 2);
        trainingExecutionConfirmation.disabled = false;
        setStatus("Locked Training preflight passed", "ok");
      } catch (error) {
        document.getElementById("trainingExecutionPreflightResult").textContent =
          JSON.stringify(error.response ?? { error: error.message }, null, 2);
        setStatus("Locked Training preflight rejected", "error");
      } finally {
        setBusy(false);
      }
    });
    document.getElementById("runLockedTraining").addEventListener("click", async () => {
      if (!state.trainingExecutionPreflight || !trainingExecutionConfirmation.checked) return;
      setBusy(true);
      setStatus("Running on locked synthetic Training page");
      try {
        const json = await requestJson("/api/training/run-locked", {
          studioProfileId: state.profile.id,
          workflowId: state.workflow?.id,
          preflightToken: state.trainingExecutionPreflight.token,
          confirmed: trainingExecutionConfirmation.checked
        });
        state.trainingExecutionPreflight = null;
        trainingExecutionConfirmation.checked = false;
        state.telemetry = json.telemetry;
        state.lifecycle = json.lifecycle;
        document.getElementById("runtimeCalls").textContent = "0";
        document.getElementById("trainingExecutionTelemetry").textContent =
          JSON.stringify({
            stepResults: json.telemetry.steps,
            durationMs: json.telemetry.durationMs,
            runtimeLlmCalls: json.telemetry.llmCalls,
            openAIRequests: json.telemetry.openAIRequests
          }, null, 2);
        renderLifecycle();
        setStatus(json.status, "ok");
      } catch (error) {
        state.trainingExecutionPreflight = null;
        trainingExecutionConfirmation.checked = false;
        const result = error.response ?? { error: error.message };
        document.getElementById("trainingExecutionTelemetry").textContent =
          JSON.stringify(result, null, 2);
        setStatus("Locked Training test stopped", "error");
      } finally {
        setBusy(false);
      }
    });
    const lifecycleRequest = async (action, body = {}) => {
      if (!state.workflow) throw new Error("Compile a fixture workflow first.");
      const json = await requestJson(
        "/api/workflows/" + encodeURIComponent(state.workflow.id) + "/" + action,
        body
      );
      if (json.lifecycle) state.lifecycle = json.lifecycle;
      renderLifecycle();
      return json;
    };
    document.getElementById("validateWorkflow").addEventListener("click", async () => {
      setBusy(true);
      setStatus("Validating variants A and B");
      try {
        const json = await lifecycleRequest("validate");
        state.telemetry = json.lifecycle.validation;
        setStatus("Workflow Validated on A/B", "ok");
      } catch (error) {
        setStatus("Validation failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    document.getElementById("approveWorkflow").addEventListener("click", async () => {
      setBusy(true);
      try {
        await lifecycleRequest("approve", {
          confirmed: document.getElementById("approvalConfirmation").checked
        });
        setStatus("Workflow Approved", "ok");
      } catch (error) {
        setStatus("Approval failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    document.getElementById("promoteWorkflow").addEventListener("click", async () => {
      setBusy(true);
      try {
        const json = await lifecycleRequest("promote");
        document.getElementById("preflightReport").textContent = JSON.stringify({
          status: "Promotion complete — preflight required",
          workflowSha256: json.lifecycle.promotion.workflowSha256,
          runtimeOpenAIPolicy: json.lifecycle.promotion.runtimeOpenAIPolicy
        }, null, 2);
        setStatus("Workflow Promoted", "ok");
      } catch (error) {
        setStatus("Promotion failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    document.getElementById("revokeWorkflow").addEventListener("click", async () => {
      setBusy(true);
      try {
        await lifecycleRequest("revoke");
        state.preflight = null;
        setStatus("Workflow Revoked", "warn");
      } catch (error) {
        setStatus("Revocation failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    const runPreflight = async clinical => {
      setBusy(true);
      setStatus("Running local structural preflight");
      try {
        const confirmed = clinical
          ? document.getElementById("clinicalConfirmation").checked
          : document.getElementById("preflightConfirmation").checked;
        const json = await lifecycleRequest("preflight", { confirmed });
        state.preflight = json.preflight;
        const report = {
          ...json.preflight,
          plannedActions: json.plannedActions,
          llmCalls: json.llmCalls,
          openAIRequests: json.openAIRequests
        };
        document.getElementById("preflightReport").textContent = JSON.stringify(report, null, 2);
        document.getElementById("clinicalPreflightResult").textContent = JSON.stringify(report, null, 2);
        document.getElementById("clinicalMetrics").innerHTML =
          "Hash verification: passed<br>Structural compatibility: " +
          Math.round(json.preflight.structuralCompatibility * 100) +
          "%<br>Runtime LLM calls: 0<br>OpenAI requests: 0";
        setStatus("Preflight passed", "ok");
      } catch (error) {
        state.preflight = null;
        setStatus("Preflight rejected", "error");
        const report = error.response ?? { error: error.message };
        document.getElementById("preflightReport").textContent = JSON.stringify(report, null, 2);
        document.getElementById("clinicalPreflightResult").textContent = JSON.stringify(report, null, 2);
      } finally {
        setBusy(false);
      }
    };
    document.getElementById("fixturePreflight").addEventListener("click", () => runPreflight(false));
    const runPromoted = async variant => {
      setBusy(true);
      setStatus("Executing promoted workflow locally");
      try {
        const json = await lifecycleRequest("run-promoted", { variant });
        state.telemetry = json.telemetry;
        document.getElementById("runtimeCalls").textContent = String(json.llmCalls);
        document.getElementById("fixtureRuntimeResult").textContent = JSON.stringify({
          workflowApproved: json.workflowApproved,
          structuralCompatibility: json.structuralCompatibility,
          stepResults: json.telemetry.steps.map(step => ({
            stepId: step.stepId,
            action: step.action,
            status: step.status
          })),
          runtimeLlmCalls: json.llmCalls,
          openAIRequests: json.openAIRequests,
          audit: json.audit
        }, null, 2);
        setStatus("Promoted workflow passed on variant " + variant, "ok");
      } catch (error) {
        setStatus("Promoted execution failed", "error");
        document.getElementById("fixtureRuntimeResult").textContent =
          JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    };
    document.getElementById("runPromotedA").addEventListener("click", () => runPromoted("A"));
    document.getElementById("runPromotedB").addEventListener("click", () => runPromoted("B"));
    document.getElementById("openManagedBrowser").addEventListener("click", async () => {
      if (
        state.profile.managedBrowserOnly &&
        !labActive() &&
        !window.confirm("This explicit action starts a visible, manual authentication bootstrap. Capture and compilation remain disabled until the browser returns to the configured application origin and you lock it. Continue?")
      ) return;
      setBusy(true);
      setStatus("Opening managed browser");
      resetCapture();
      renderAuthenticationState({
        phase: "authentication-bootstrap",
        canLock: false
      });
      pollAuthenticationStatus();
      try {
        const result = await requestJson("/api/managed-browser/open", {
          studioProfileId: state.profile.id,
          targetUrl: targetUrl.value,
          explicitUserAction: true,
          syntheticAttestation: syntheticAttestation(),
          labSessionToken: state.labSessionToken
        });
        renderAuthenticationState(result);
        if (labActive()) setLabStage("Browser");
        pollAuthenticationStatus();
        setStatus(result.status, "warn");
      } catch (error) {
        renderAuthenticationState({ phase: "idle", canLock: false });
        setStatus("Managed browser opening failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    document.getElementById("lockManagedBrowser").addEventListener("click", async () => {
      setBusy(true);
      setStatus("Locking managed browser to application origin");
      try {
        const result = await requestJson("/api/managed-browser/lock", {
          studioProfileId: state.profile.id,
          explicitUserAction: true
        });
        window.clearTimeout(authenticationPollTimer);
        renderAuthenticationState(result);
        if (labActive()) setLabStage("Locked");
        setStatus(result.status, "ok");
      } catch (error) {
        const status = error.response ?? {};
        if (status.phase) renderAuthenticationState(status);
        setStatus("Application lock refused", "error");
        output.textContent = JSON.stringify(status.error ? status : { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    const labConfirmation = document.getElementById("labSyntheticConfirmation");
    labConfirmation.addEventListener("change", () => {
      document.getElementById("confirmLabSession").disabled =
        !labModeEnabled || !labConfirmation.checked || state.profile.mode === "clinical";
    });
    document.getElementById("confirmLabSession").addEventListener("click", async () => {
      try {
        const result = await requestJson("/api/lab/confirm", {
          studioProfileId: state.profile.id,
          confirmed: labConfirmation.checked
        });
        state.labSessionToken = result.token;
        document.getElementById("labConfirmation").classList.add("hidden");
        document.getElementById("labConfirmedState").classList.remove("hidden");
        document.getElementById("syntheticAttestation").classList.add("hidden");
        document.getElementById("trainingExecutionPanel").classList.add("hidden");
        document.getElementById("labResult").textContent =
          "Synthetic Lab session confirmed once. Open the managed browser.";
        setLabStage("Browser");
        syncJourneyControls();
      } catch (error) {
        document.getElementById("labResult").textContent =
          JSON.stringify(error.response ?? { error: error.message }, null, 2);
      }
    });
    const ensureLabCapture = async force => {
      let needsCapture = force || !state.capture;
      let reason = needsCapture ? "Capture required." : "Checking page structure.";
      if (!needsCapture && state.profile.id === "ncba-dpi-training") {
        const status = await requestJson("/api/lab/capture-status", {
          studioProfileId: state.profile.id,
          labSessionToken: state.labSessionToken,
          captureId: state.capture?.captureId
        });
        needsCapture = status.needsCapture;
        reason = status.reason;
      }
      if (needsCapture) {
        setStatus("Capturing current Lab page");
        await captureCurrentPage();
        reason = force
          ? "Explicit recapture complete."
          : "Automatic capture complete.";
      }
      document.getElementById("labResult").textContent = reason;
      return state.capture;
    };
    document.getElementById("labCapture").addEventListener("click", async () => {
      setBusy(true);
      try {
        await ensureLabCapture(true);
        setStatus("Lab capture ready", "ok");
      } catch (error) {
        setLabStage("Failed");
        setStatus("Lab capture failed", "error");
        document.getElementById("labResult").textContent =
          JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    const labCompile = async forceRecapture => {
      if (state.compileInFlight || state.labPreparing) return;
      state.labPreparing = true;
      syncJourneyControls();
      try {
        await ensureLabCapture(forceRecapture);
        state.labPreparing = false;
        await compileCurrentInstruction(forceRecapture);
      } catch (error) {
        setLabStage("Failed");
        setStatus("Lab compilation failed", "error");
        document.getElementById("labResult").textContent =
          JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        state.labPreparing = false;
        syncJourneyControls();
      }
    };
    document.getElementById("labCompile").addEventListener("click", () => labCompile(false));
    document.getElementById("labRecaptureCompile").addEventListener("click", () => labCompile(true));
    const runLabWorkflow = async () => {
      if (state.labRunning) return;
      state.labRunning = true;
      setLabStage("Running");
      setStatus("Running on current locked Lab page");
      const phaseStatus = document.getElementById("labRuntimePhase");
      phaseStatus.textContent = "Resolving target";
      syncJourneyControls();
      let progressRequestActive = false;
      const pollProgress = async () => {
        if (progressRequestActive || !state.labRunning) return;
        progressRequestActive = true;
        try {
          const progress = await requestJson("/api/lab/run-status", {
            studioProfileId: state.profile.id,
            labSessionToken: state.labSessionToken
          }, { timeoutMs: 3_000 });
          if (progress.current) {
            phaseStatus.textContent =
              progress.current.label + " · " + progress.current.phase;
          }
        } catch {
          // The execution response remains authoritative; polling is display-only.
        } finally {
          progressRequestActive = false;
        }
      };
      const progressTimer = window.setInterval(pollProgress, 250);
      try {
        const json = await requestJson("/api/lab/run", {
          studioProfileId: state.profile.id,
          labSessionToken: state.labSessionToken,
          workflowId: state.workflow?.id
        }, { timeoutMs: 120_000 });
        state.telemetry = json.telemetry;
        state.lifecycle = json.lifecycle;
        state.labRunCompleted = true;
        document.getElementById("runtimeCalls").textContent = "0";
        document.getElementById("labResult").textContent = JSON.stringify({
          status: json.status,
          steps: json.telemetry.steps,
          llmCalls: json.telemetry.llmCalls,
          openAIRequests: json.telemetry.openAIRequests
        }, null, 2);
        setLabStage("Passed");
        phaseStatus.textContent = "Compilation-independent Lab execution complete.";
        setStatus(json.status, "ok");
        renderLifecycle();
      } catch (error) {
        state.labRunCompleted = true;
        setLabStage("Failed");
        phaseStatus.textContent = "Lab execution stopped at the failed phase.";
        setStatus("Lab run failed or stopped", "error");
        document.getElementById("labResult").textContent =
          JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        window.clearInterval(progressTimer);
        state.labRunning = false;
        syncJourneyControls();
      }
    };
    document.getElementById("labRun").addEventListener("click", runLabWorkflow);
    document.getElementById("labRunAgain").addEventListener("click", runLabWorkflow);
    document.getElementById("labStop").addEventListener("click", async () => {
      try {
        const result = await requestJson("/api/lab/stop", {
          studioProfileId: state.profile.id,
          labSessionToken: state.labSessionToken
        });
        state.labRunning = false;
        document.getElementById("labRuntimePhase").textContent =
          "Execution stopped by operator.";
        setStatus("Lab run stopped; managed session preserved", "warn");
        document.getElementById("labResult").textContent =
          JSON.stringify(result, null, 2);
      } finally {
        syncJourneyControls();
      }
    });
    document.getElementById("labReset").addEventListener("click", async () => {
      await requestJson("/api/lab/reset", {
        studioProfileId: state.profile.id,
        labSessionToken: state.labSessionToken
      });
      state.labSessionToken = null;
      state.labRunCompleted = false;
      resetCapture();
      labConfirmation.checked = false;
      document.getElementById("labConfirmation").classList.remove("hidden");
      document.getElementById("labConfirmedState").classList.add("hidden");
      document.getElementById("labResult").textContent =
        "Lab session reset. The managed authentication session remains open.";
      renderProfile(state.profile);
    });
    [...attestationInputs, indicatorVerified, compilerPayloadConfirmation, restoreArtifactConfirmation, trainingExecutionConfirmation].forEach(input => {
      input.addEventListener("change", syncJourneyControls);
    });
    targetUrl.addEventListener("input", () => {
      state.targetValid = false;
      resetCapture();
      document.getElementById("targetValidation").textContent =
        "Target changed — local validation required.";
      document.getElementById("targetValidation").className = "hint warn";
      syncJourneyControls();
      window.clearTimeout(targetValidationTimer);
      targetValidationTimer = window.setTimeout(validateTargetInput, 250);
    });
    targetUrl.addEventListener("change", validateTargetInput);
    document.getElementById("approvalConfirmation").addEventListener("change", syncJourneyControls);
    document.getElementById("preflightConfirmation").addEventListener("change", syncJourneyControls);
    document.getElementById("clinicalConfirmation").addEventListener("change", syncJourneyControls);
    profileSelect.addEventListener("change", () => {
      const profile = studioProfiles.find(candidate => candidate.id === profileSelect.value);
      if (profile) renderProfile(profile);
    });
    document.getElementById("clinicalStop").addEventListener("click", () => {
      setStatus("Clinical run stopped", "warn");
    });
    document.getElementById("clinicalPreflight").addEventListener("click", () => runPreflight(true));
    document.getElementById("clinicalRun").addEventListener("click", () => runPromoted("A"));
    document.getElementById("deleteClinicalProfile").addEventListener("click", async () => {
      if (!window.confirm("Delete the independent local clinical browser profile?")) return;
      const response = await fetch("/api/browser-profiles/" + encodeURIComponent(state.profile.id), { method: "DELETE" });
      const result = await response.json();
      setStatus(response.ok ? result.status : result.error, response.ok ? "ok" : "error");
    });
    workflowSelect.addEventListener("change", () => {
      restoreArtifactConfirmation.checked = false;
      loadWorkflow(workflowSelect.value).catch(error => {
        setStatus("Failed", "error");
        output.textContent = JSON.stringify({ error: error.message }, null, 2);
      });
    });
    profileSelect.replaceChildren(
      ...studioProfiles.map(profile => {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.id + " — " + profile.name;
        return option;
      })
    );
    renderProfile(studioProfiles[0]);
    render();
    refreshWorkflowList(${JSON.stringify(defaultWorkflowId)})
      .then(loadWorkflow)
      .catch(error => {
        setStatus("Failed", "error");
        output.textContent = JSON.stringify({ error: error.message }, null, 2);
      });
  </script>
</body>
</html>`;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});

app.get("/", (_req, res) => res.type("html").send(studioHtml()));
app.get("/health", async (_req, res) => {
  try {
    await ensureWorkflowStorage();
    res.json({
      ok: true,
      status: "healthy",
      service: "studio",
      storage: {
        writable: true,
        workflowPresent: existsSync(WORKFLOW_PATH),
      },
      runtimeOpenAIAllowed: false,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      status: "unhealthy",
      service: "studio",
      storage: { writable: false },
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
app.get("/api/lab/config", (_req, res) => {
  res.json({
    enabled: labModeEnabled,
    requiresLocalStudioHost: true,
    allowedProfiles: ["ncba-dpi-fixture", "ncba-dpi-training"],
    clinicalAllowed: false,
  });
});
app.post("/api/lab/confirm", (req, res) => {
  const parsedProfileId = StudioProfileIdSchema.safeParse(
    req.body.studioProfileId,
  );
  if (
    !labModeEnabled ||
    !parsedProfileId.success ||
    !isLabProfile(parsedProfileId.data) ||
    req.body.confirmed !== true
  ) {
    res.status(403).json({
      error:
        "LAB MODE requires a local Studio, a non-clinical profile, and explicit synthetic-session confirmation.",
    });
    return;
  }
  const token = randomUUID();
  const confirmedAt = new Date().toISOString();
  labSessions.set(token, {
    confirmedAt,
    expiresAt: Date.now() + LAB_SESSION_TTL_MS,
  });
  res.json({
    token,
    confirmedAt,
    status: "LAB MODE — SYNTHETIC TEST ENVIRONMENT",
  });
});
app.post("/api/lab/reset", async (req, res) => {
  const parsedProfileId = StudioProfileIdSchema.safeParse(
    req.body.studioProfileId,
  );
  if (
    !parsedProfileId.success ||
    !isLabAuthorized(req.body.labSessionToken, parsedProfileId.data)
  ) {
    res.status(403).json({ error: "Active LAB MODE session required." });
    return;
  }
  labSessions.delete(req.body.labSessionToken);
  activeLabRuns.get(parsedProfileId.data)?.abort();
  activeLabRuns.delete(parsedProfileId.data);
  res.json({
    status: "Lab test session reset; managed authentication remains open.",
  });
});
app.post("/api/lab/capture-status", async (req, res) => {
  const profileId = StudioProfileIdSchema.safeParse(req.body.studioProfileId);
  if (
    !profileId.success ||
    profileId.data !== "ncba-dpi-training" ||
    !isLabAuthorized(req.body.labSessionToken, profileId.data)
  ) {
    res.status(403).json({ error: "Active Training LAB MODE required." });
    return;
  }
  const session = managedSessions.get(profileId.data);
  if (!session || session.phase !== "application-locked") {
    res.status(409).json({ error: "Application is not locked." });
    return;
  }
  const capture =
    typeof req.body.captureId === "string"
      ? captures.get(req.body.captureId)
      : undefined;
  if (!capture || capture.managedSessionId !== session.id) {
    res.json({ needsCapture: true, reason: "No current-session capture." });
    return;
  }
  if (
    canonicalizeTargetUrl(capture.pageModel.url) !==
    canonicalizeTargetUrl(session.primaryPage.url())
  ) {
    res.json({
      needsCapture: true,
      reason: "Canonical pathname changed — automatic recapture required.",
    });
    return;
  }
  const currentModel = await extractManagedPageModel(
    session.primaryPage,
    session.applicationOrigin,
  );
  const currentFingerprint = createStructuralFingerprint(
    redactCapturedPageModel(currentModel),
  );
  const compatibility = compareStructuralFingerprints(
    capture.fingerprint,
    currentFingerprint,
  );
  res.json({
    needsCapture: currentFingerprint.sha256 !== capture.fingerprint.sha256,
    reason:
      currentFingerprint.sha256 === capture.fingerprint.sha256
        ? "Structure unchanged — capture reused."
        : "Structure changed — automatic recapture required.",
    structuralCompatibility: compatibility.score,
  });
});
app.get("/api/application-profiles", (_req, res) => {
  res.json({ profiles: studioProfiles });
});
app.post("/api/target/validate", (req, res) => {
  const parsedProfileId = StudioProfileIdSchema.safeParse(
    req.body.studioProfileId,
  );
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "Unknown Studio application profile." });
    return;
  }
  try {
    const resolved = resolveStudioTarget({
      profileId: parsedProfileId.data,
      targetUrl: String(req.body.targetUrl ?? ""),
      purpose: "open",
    });
    res.json({
      accepted: true,
      origin: resolved.url.origin,
      canonicalUrl: canonicalizeTargetUrl(resolved.url),
      queryParametersDiscarded: resolved.url.search.length > 0,
    });
  } catch {
    res.status(400).json({
      accepted: false,
      error: "Target URL is not allowed by the active Application Profile.",
    });
  }
});
app.post("/api/managed-browser/open", async (req, res) => {
  if (req.body.explicitUserAction !== true) {
    res.status(400).json({
      error: "Opening a managed browser requires an explicit user action.",
    });
    return;
  }
  const parsedProfileId = StudioProfileIdSchema.safeParse(
    req.body.studioProfileId,
  );
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "Unknown Studio application profile." });
    return;
  }
  try {
    const resolved = resolveStudioTarget({
      profileId: parsedProfileId.data,
      targetUrl: String(req.body.targetUrl ?? ""),
      purpose: "open",
    });
    if (
      resolved.profile.syntheticAttestationRequired &&
      !isLabAuthorized(req.body.labSessionToken, parsedProfileId.data)
    ) {
      try {
        requireValidAttestation(
          req.body.syntheticAttestation,
          resolved.applicationProfile,
        );
      } catch {
        res.status(403).json({
          error:
            "Managed browser opening requires a fresh synthetic-environment attestation.",
        });
        return;
      }
    }
    const session = await openManagedBrowser(
      parsedProfileId.data,
      resolved.url,
    );
    res.json({
      status: "AUTHENTICATION IN PROGRESS — capture and compilation disabled",
      profileId: resolved.profile.id,
      mode: resolved.profile.mode,
      ...managedSessionStatus(session),
    });
  } catch {
    res.status(400).json({
      error:
        "Managed browser navigation failed or was blocked by the origin policy.",
    });
  }
});
app.get("/api/managed-browser/status/:profileId", (req, res) => {
  const parsedProfileId = StudioProfileIdSchema.safeParse(req.params.profileId);
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "Unknown Studio application profile." });
    return;
  }
  const session = managedSessions.get(parsedProfileId.data);
  if (!session) {
    res.json({
      phase: "idle",
      canLock: false,
      captureAllowed: false,
      compilationAllowed: false,
      llmCalls: 0,
      openAIRequests: 0,
    });
    return;
  }
  res.json(managedSessionStatus(session));
});
app.post("/api/managed-browser/lock", async (req, res) => {
  if (req.body.explicitUserAction !== true) {
    res.status(400).json({ error: "Explicit lock action is required." });
    return;
  }
  const parsedProfileId = StudioProfileIdSchema.safeParse(
    req.body.studioProfileId,
  );
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "Unknown Studio application profile." });
    return;
  }
  const session = managedSessions.get(parsedProfileId.data);
  if (!session) {
    res.status(409).json({ error: "No managed authentication session." });
    return;
  }
  try {
    res.json({
      status: "APPLICATION LOCKED — capture and compilation enabled",
      ...(await lockManagedBrowserToApplication(session)),
    });
  } catch {
    res.status(409).json({
      error:
        "Lock refused: primary page is not on the configured application origin.",
      ...managedSessionStatus(session),
    });
  }
});
if (allowExplicitLocalSsoFixture) {
  app.post("/api/test-only/sso/continue", async (req, res) => {
    const session = managedSessions.get("ncba-dpi-training");
    if (!session || session.phase !== "authentication-bootstrap") {
      res.status(409).json({ error: "Synthetic SSO bootstrap is not active." });
      return;
    }
    try {
      const applicationReturn = session.primaryPage.waitForURL(
        (url) => url.origin === session.applicationOrigin,
        { timeout: 10_000 },
      );
      if (req.body.flow === "popup") {
        const popupPromise = session.context.waitForEvent("page");
        await session.primaryPage
          .getByRole("button", {
            name: "Open synthetic authentication popup",
          })
          .click();
        const popup = await popupPromise;
        await popup
          .getByRole("button", {
            name: "Complete synthetic popup authentication",
          })
          .click();
      } else {
        await session.primaryPage
          .getByRole("button", {
            name: "Continue synthetic authentication",
          })
          .click();
      }
      await applicationReturn;
      res.json({
        status: "Synthetic authentication returned to application",
        flow: req.body.flow === "popup" ? "popup" : "redirect",
        ...managedSessionStatus(session),
      });
    } catch {
      res.status(500).json({ error: "Synthetic SSO continuation failed." });
    }
  });
  app.post("/api/test-only/sso/attempt-exit", async (_req, res) => {
    const session = managedSessions.get("ncba-dpi-training");
    if (!session || session.phase !== "application-locked") {
      res.status(409).json({ error: "Application is not locked." });
      return;
    }
    let blocked = false;
    try {
      await session.primaryPage.goto(
        `${syntheticSsoAuthOrigin}/outside?exit_token=SYNTHETIC-EXIT-TOKEN`,
      );
    } catch {
      blocked = true;
    }
    res.json({
      blocked,
      ...managedSessionStatus(session),
    });
  });
  app.post("/api/test-only/sso/probe-openai-block", async (_req, res) => {
    const session = managedSessions.get("ncba-dpi-training");
    if (!session) {
      res.status(409).json({ error: "Managed session is not active." });
      return;
    }
    const blocked = await session.primaryPage.evaluate(async () => {
      try {
        await fetch("https://api.openai.com/v1/models");
        return false;
      } catch {
        return true;
      }
    });
    res.json({ blocked, llmCalls: 0, openAIRequests: 0 });
  });
  app.post("/api/test-only/training/navigate", async (req, res) => {
    const session = managedSessions.get("ncba-dpi-training");
    if (!session || session.phase !== "application-locked") {
      res.status(409).json({ error: "Application is not locked." });
      return;
    }
    const pathname =
      req.body.destination === "wrong-path"
        ? "/ncba-fixture?mode=training&variant=A"
        : req.body.destination === "modified"
          ? "/cgi-professional?legacy=1&frames=1&layout=modified"
          : "/cgi-professional?legacy=1&frames=1";
    try {
      await session.primaryPage.goto(`${session.applicationOrigin}${pathname}`);
      res.json({
        navigated: true,
        canonicalUrl: canonicalizeTargetUrl(session.primaryPage.url()),
        llmCalls: 0,
        openAIRequests: 0,
      });
    } catch {
      res.status(409).json({ error: "Synthetic navigation failed." });
    }
  });
  app.get("/api/test-only/training/cgi-state", async (_req, res) => {
    const session = managedSessions.get("ncba-dpi-training");
    if (!session || session.phase !== "application-locked") {
      res.status(409).json({ error: "Application is not locked." });
      return;
    }
    const result = await session.primaryPage.evaluate(() => ({
      expectedSyntheticValuePresent:
        (document.querySelector("#observation") as HTMLTextAreaElement | null)
          ?.value === "test du DR LEROY",
      secondSyntheticValuePresent:
        (document.querySelector("#observation") as HTMLTextAreaElement | null)
          ?.value === "second test synthétique",
      savePostconditionVisible:
        document.querySelector("#observation-result")?.textContent ===
        "Enregistrement synthétique effectué",
    }));
    res.json({ ...result, llmCalls: 0, openAIRequests: 0 });
  });
}
app.delete("/api/browser-profiles/:profileId", async (req, res) => {
  const parsedProfileId = StudioProfileIdSchema.safeParse(req.params.profileId);
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "Unknown Studio application profile." });
    return;
  }
  const session = managedSessions.get(parsedProfileId.data);
  await session?.context.close();
  await session?.browser.close();
  managedSessions.delete(parsedProfileId.data);
  const profileDirectory = path.join(browserProfileRoot, parsedProfileId.data);
  await rm(profileDirectory, { recursive: true, force: true });
  res.json({ status: `${parsedProfileId.data} browser profile deleted` });
});
app.post("/api/browser-profiles/:profileId/prepare", async (req, res) => {
  const parsedProfileId = StudioProfileIdSchema.safeParse(req.params.profileId);
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "Unknown Studio application profile." });
    return;
  }
  const profile = studioProfiles.find(
    (candidate) => candidate.id === parsedProfileId.data,
  )!;
  res.json({
    status: `${profile.id} ephemeral browser session ready`,
    persistence: "memory-only",
    compilationAllowed: profile.compilationAllowed,
  });
});
app.post("/api/clinical/compile", (_req, res) => {
  res
    .status(403)
    .json({ error: "Compilation is technically disabled in clinical mode." });
});
app.post("/api/capture", async (req, res) => {
  const parsedProfileId = StudioProfileIdSchema.safeParse(
    req.body.studioProfileId,
  );
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "A valid Studio profile is required." });
    return;
  }
  const studioProfile = studioProfiles.find(
    (candidate) => candidate.id === parsedProfileId.data,
  )!;
  if (!studioProfile.captureAllowed) {
    res
      .status(403)
      .json({ error: "Page-model capture is disabled in clinical mode." });
    return;
  }
  let resolved: ReturnType<typeof resolveStudioProfileTarget>;
  try {
    resolved = resolveStudioTarget({
      profileId: parsedProfileId.data,
      targetUrl: String(req.body.targetUrl ?? ""),
      purpose: "capture",
    });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  let attestation: { attestedAt: string };
  if (isLabAuthorized(req.body.labSessionToken, parsedProfileId.data)) {
    attestation = { attestedAt: new Date().toISOString() };
  } else {
    try {
      attestation = requireValidAttestation(
        req.body.syntheticAttestation,
        resolved.applicationProfile,
      );
    } catch {
      res.status(403).json({
        error:
          "Capture closed: complete fresh synthetic-environment attestation is required.",
      });
      return;
    }
  }
  try {
    let pageModel: PageModel;
    let managedSessionId: string | undefined;
    let crossOriginFramesExcluded = 0;
    if (studioProfile.managedBrowserOnly) {
      const session = managedSessions.get(studioProfile.id);
      if (!session) {
        res.status(409).json({
          error:
            "Open this training profile manually in its managed browser before capture.",
        });
        return;
      }
      if (session.phase !== "application-locked") {
        res.status(423).json({
          error:
            "AUTHENTICATION IN PROGRESS — capture and compilation disabled.",
        });
        return;
      }
      const page = session.primaryPage;
      resolveStudioTarget({
        profileId: studioProfile.id,
        targetUrl: page.url(),
        purpose: "capture",
      });
      crossOriginFramesExcluded = page.frames().filter((frame) => {
        if (frame === page.mainFrame()) return false;
        try {
          return new URL(frame.url()).origin !== session.applicationOrigin;
        } catch {
          return true;
        }
      }).length;
      pageModel = await extractManagedPageModel(
        page,
        session.applicationOrigin,
      );
      managedSessionId = session.id;
    } else {
      const internalTarget = new URL(
        `${resolved.url.pathname}${resolved.url.search}`,
        internalDemoUrl,
      );
      pageModel = await captureLocalFixture(internalTarget.toString());
    }
    const redactedModel = redactCapturedPageModel(pageModel);
    const fingerprint = createStructuralFingerprint(redactedModel);
    const compilerPayload = createRedactedCompilerPageModel(pageModel);
    const compilerPayloadSha256 = createHash("sha256")
      .update(JSON.stringify(compilerPayload))
      .digest("hex");
    const id = randomUUID();
    captures.set(id, {
      id,
      studioProfileId: studioProfile.id,
      pageModel,
      redactedModel,
      fingerprint,
      attestedAt: attestation.attestedAt,
      managedSessionId,
      compilerPayload,
      compilerPayloadSha256,
    });
    res.json({
      captureId: id,
      profileId: studioProfile.id,
      redactionReport: redactedModel.report,
      compilerBoundaryReport: compilerPayload.redactionReport,
      compilerPayload,
      compilerPayloadSha256,
      structuralFingerprint: fingerprint,
      crossOriginFramesExcluded,
      capturedValuesReturned: false,
      llmCalls: 0,
      openAIRequests: 0,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/api/compile-status", (req, res) => {
  const requestId = typeof req.query.id === "string" ? req.query.id : "";
  const progress = compilationRequests.get(requestId);
  if (!progress) {
    res.status(404).json({ error: "Compilation request not found." });
    return;
  }
  res.json(progress);
});
app.post("/api/compile", async (req, res) => {
  const requestId =
    typeof req.body.requestId === "string" &&
    /^[a-zA-Z0-9-]{8,80}$/.test(req.body.requestId)
      ? req.body.requestId
      : randomUUID();
  updateCompilationProgress(requestId, "Preparing redacted payload");
  scheduleCompilationProgressCleanup(requestId);
  const parsedProfileId = StudioProfileIdSchema.safeParse(
    req.body.studioProfileId,
  );
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "A valid Studio profile is required." });
    return;
  }
  const studioProfile = studioProfiles.find(
    (candidate) => candidate.id === parsedProfileId.data,
  )!;
  if (studioProfile.mode === "clinical") {
    res
      .status(403)
      .json({ error: "Compilation is technically disabled in clinical mode." });
    return;
  }
  let resolved: ReturnType<typeof resolveStudioProfileTarget>;
  try {
    resolved = resolveStudioTarget({
      profileId: parsedProfileId.data,
      targetUrl: String(req.body.targetUrl ?? ""),
      purpose: "compile",
    });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const labAuthorized = isLabAuthorized(
    req.body.labSessionToken,
    parsedProfileId.data,
  );
  if (!labAuthorized) {
    try {
      requireValidAttestation(
        req.body.syntheticAttestation,
        resolved.applicationProfile,
      );
    } catch {
      res.status(403).json({
        error:
          "Compilation closed: complete fresh synthetic-environment attestation is required.",
      });
      return;
    }
  }
  try {
    const managedSession = studioProfile.managedBrowserOnly
      ? managedSessions.get(studioProfile.id)
      : undefined;
    if (
      studioProfile.managedBrowserOnly &&
      (!managedSession || managedSession.phase !== "application-locked")
    ) {
      res.status(423).json({
        error: "AUTHENTICATION IN PROGRESS — capture and compilation disabled.",
      });
      return;
    }
    const instruction =
      typeof req.body.instruction === "string"
        ? req.body.instruction.trim()
        : DEFAULT_INSTRUCTION;
    if (!instruction || instruction.length > 10_000) {
      res.status(400).json({
        error: "Instruction must contain between 1 and 10,000 characters.",
      });
      return;
    }
    await ensureWorkflowStorage();
    const captureId =
      typeof req.body.captureId === "string" ? req.body.captureId : "";
    const capture = captures.get(captureId);
    if (
      !capture ||
      capture.studioProfileId !== studioProfile.id ||
      (studioProfile.managedBrowserOnly &&
        capture.managedSessionId !== managedSession?.id)
    ) {
      res.status(409).json({
        error:
          "A fresh attested capture for the active profile is required before compilation.",
      });
      return;
    }
    if (
      (!labAuthorized && req.body.compilerPayloadConfirmed !== true) ||
      req.body.compilerPayloadSha256 !== capture.compilerPayloadSha256
    ) {
      res.status(428).json({
        error:
          "Compilation closed: review and explicitly confirm the exact redacted compiler payload.",
      });
      return;
    }
    const compilerPageModel: PageModel = {
      ...capture.pageModel,
      url: canonicalizeTargetUrl(capture.pageModel.url),
    };
    const canonicalUrl = canonicalizeTargetUrl(compilerPageModel.url);
    const idempotencyKey = compileIdempotencyKey({
      instruction,
      studioProfileId: studioProfile.id,
      canonicalUrl,
      compilerPayloadSha256: capture.compilerPayloadSha256,
    });
    if (activeCompilationKeys.has(idempotencyKey)) {
      updateCompilationProgress(requestId, "Preparing redacted payload", {
        complete: true,
        error: "An identical compilation is already in progress.",
      });
      res.status(409).json({
        error: "An identical compilation is already in progress.",
      });
      return;
    }
    activeCompilationKeys.add(idempotencyKey);
    try {
      const reusable =
        req.body.forceNewCompilation === true
          ? null
          : await findIdempotentDraft({
              idempotencyKey,
              capture,
              studioProfileId: studioProfile.id,
              canonicalUrl,
              instruction,
            });
      if (reusable) {
        updateCompilationProgress(requestId, "Compilation complete", {
          complete: true,
        });
        res.json(compactCompileResponse(reusable, { reused: true }));
        return;
      }
      const workflow = await compileWorkflow({
        instruction,
        url: canonicalUrl,
        outDir: WORKFLOW_STORAGE_DIR,
        pageModel: compilerPageModel,
        onProgress: async (stage) => {
          updateCompilationProgress(requestId, stage);
          if (compileProgressDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, compileProgressDelayMs),
            );
          }
        },
      });
      const artifact = await readWorkflowArtifact(workflow.id);
      const lifecycle = await createDraftRecord({
        workflow: artifact.workflow,
        capture,
        studioProfileId: studioProfile.id,
        canonicalUrl,
        idempotencyKey,
        artifactSha256: artifact.sha256,
      });
      updateCompilationProgress(requestId, "Compilation complete", {
        complete: true,
      });
      res.json(compactCompileResponse(lifecycle, { reused: false }));
    } finally {
      activeCompilationKeys.delete(idempotencyKey);
    }
  } catch (error) {
    const current =
      compilationRequests.get(requestId)?.stage ?? "Preparing redacted payload";
    updateCompilationProgress(requestId, current, {
      complete: true,
      error: "Compilation failed.",
    });
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/workflows/restore-draft", async (req, res) => {
  const parsedProfileId = StudioProfileIdSchema.safeParse(
    req.body.studioProfileId,
  );
  if (!parsedProfileId.success) {
    res.status(400).json({ error: "A valid Training profile is required." });
    return;
  }
  const studioProfile = studioProfiles.find(
    (candidate) => candidate.id === parsedProfileId.data,
  )!;
  const labAuthorized = isLabAuthorized(
    req.body.labSessionToken,
    parsedProfileId.data,
  );
  if (
    studioProfile.mode === "clinical" ||
    (!labAuthorized && req.body.restoreConfirmed !== true)
  ) {
    res.status(403).json({
      error:
        "Draft restoration requires Training mode and explicit human confirmation.",
    });
    return;
  }
  let resolved: ReturnType<typeof resolveStudioProfileTarget>;
  try {
    resolved = resolveStudioTarget({
      profileId: studioProfile.id,
      targetUrl: String(req.body.targetUrl ?? ""),
      purpose: "compile",
    });
    if (!labAuthorized) {
      requireValidAttestation(
        req.body.syntheticAttestation,
        resolved.applicationProfile,
      );
    }
  } catch (error) {
    res.status(403).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    const captureId =
      typeof req.body.captureId === "string" ? req.body.captureId : "";
    const capture = captures.get(captureId);
    if (
      !capture ||
      capture.studioProfileId !== studioProfile.id ||
      req.body.compilerPayloadSha256 !== capture.compilerPayloadSha256
    ) {
      res.status(409).json({
        error: "A compatible confirmed capture is required for restoration.",
      });
      return;
    }
    const workflowId =
      typeof req.body.workflowId === "string" ? req.body.workflowId : "";
    const artifact = await readWorkflowArtifact(workflowId);
    const managedSession = studioProfile.managedBrowserOnly
      ? managedSessions.get(studioProfile.id)
      : undefined;
    if (
      studioProfile.managedBrowserOnly &&
      (!managedSession ||
        managedSession.phase !== "application-locked" ||
        managedSession.id !== capture.managedSessionId)
    ) {
      throw new Error(
        "Draft restoration requires the same locked managed session as the capture.",
      );
    }
    const canonicalUrl = canonicalizeTargetUrl(
      managedSession?.primaryPage.url() ?? resolved.url.toString(),
    );
    let persisted = lifecycleRecords.get(workflowId);
    if (!persisted && existsSync(lifecyclePath(workflowId))) {
      persisted = await loadPersistedLifecycle(workflowId);
    }
    const compatibility = validateArtifactAgainstCapture({
      workflow: artifact.workflow,
      capture,
      studioProfileId: studioProfile.id,
      canonicalUrl,
      persisted,
    });
    const instruction =
      typeof req.body.instruction === "string" &&
      req.body.instruction.trim().length > 0
        ? req.body.instruction
        : artifactInstruction(artifact.workflow);
    const idempotencyKey = compileIdempotencyKey({
      instruction,
      studioProfileId: studioProfile.id,
      canonicalUrl,
      compilerPayloadSha256: capture.compilerPayloadSha256,
    });
    const lifecycle = await createDraftRecord({
      workflow: artifact.workflow,
      capture,
      studioProfileId: studioProfile.id,
      canonicalUrl,
      idempotencyKey,
      artifactSha256: artifact.sha256,
    });
    res.json({
      ...compactCompileResponse(lifecycle, { reused: true }),
      compatibility,
    });
  } catch (error) {
    res.status(409).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
app.get("/api/workflow-lifecycle", async (req, res) => {
  const workflowId = typeof req.query.id === "string" ? req.query.id : "";
  let record = lifecycleRecords.get(workflowId);
  if (!record && existsSync(lifecyclePath(workflowId))) {
    try {
      record = await loadPersistedLifecycle(workflowId);
    } catch {
      res.status(409).json({ error: "Persisted lifecycle failed validation." });
      return;
    }
  }
  if (!record) {
    res.status(404).json({ error: "No lifecycle record for this workflow." });
    return;
  }
  res.json({ lifecycle: lifecycleSummary(record) });
});
app.post("/api/training/preflight", async (req, res) => {
  if (req.body.studioProfileId !== "ncba-dpi-training") {
    res.status(403).json({
      error: "Locked Training execution requires ncba-dpi-training.",
    });
    return;
  }
  const workflowId =
    typeof req.body.workflowId === "string" ? req.body.workflowId : "";
  try {
    const prepared = await prepareLockedTrainingExecution(workflowId);
    const token = randomUUID();
    const expiresAt = Date.now() + TRAINING_EXECUTION_PREFLIGHT_TTL_MS;
    trainingExecutionPreflights.set(token, {
      token,
      workflowId,
      captureId: prepared.capture.id,
      managedSessionId: prepared.session.id,
      canonicalUrl: prepared.canonicalUrl,
      fingerprintSha256: prepared.fingerprint.sha256,
      plannedActions: prepared.plannedActions,
      expiresAt,
    });
    res.json({
      token,
      warning: "Training synthetic data only",
      result: {
        passed: true,
        profileId: "ncba-dpi-training",
        phase: "APPLICATION LOCKED",
        lifecycleState: prepared.record.state,
        sameManagedSession: true,
        originMatch: true,
        pathnameMatch: true,
        structuralCompatibility: prepared.compatibility.score,
        missingRequired: prepared.compatibility.missingRequired,
        locatorsUnique: true,
        preconditionsPassed: true,
      },
      plannedActions: prepared.plannedActions,
      expiresAt: new Date(expiresAt).toISOString(),
      llmCalls: 0,
      openAIRequests: 0,
    });
  } catch (error) {
    res.status(409).json({
      error: error instanceof Error ? error.message : String(error),
      passed: false,
      llmCalls: 0,
      openAIRequests: 0,
    });
  }
});
app.post("/api/training/run-locked", async (req, res) => {
  if (
    req.body.studioProfileId !== "ncba-dpi-training" ||
    req.body.confirmed !== true
  ) {
    res.status(403).json({
      error:
        "Locked Training execution requires the Training profile and explicit human confirmation.",
    });
    return;
  }
  const token =
    typeof req.body.preflightToken === "string" ? req.body.preflightToken : "";
  const preflight = trainingExecutionPreflights.get(token);
  trainingExecutionPreflights.delete(token);
  if (!preflight || preflight.expiresAt < Date.now()) {
    res
      .status(409)
      .json({ error: "Training preflight is missing or expired." });
    return;
  }
  try {
    const prepared = await prepareLockedTrainingExecution(
      String(req.body.workflowId ?? ""),
    );
    if (
      prepared.record.workflow.id !== preflight.workflowId ||
      prepared.capture.id !== preflight.captureId ||
      prepared.session.id !== preflight.managedSessionId ||
      prepared.canonicalUrl !== preflight.canonicalUrl ||
      prepared.fingerprint.sha256 !== preflight.fingerprintSha256
    ) {
      throw new Error(
        "The page, capture, workflow, or managed session changed after preflight.",
      );
    }
    const telemetry = await runWorkflowOnExistingPage({
      page: prepared.session.primaryPage,
      workflow: prepared.record.workflow,
      expectedOrigin: prepared.session.applicationOrigin,
    });
    const passed =
      telemetry.steps.length === prepared.record.workflow.steps.length &&
      telemetry.steps.every((step) => step.status === "passed");
    if (!passed) {
      res.status(422).json({
        error: "Training test stopped at the first failed step.",
        telemetry,
        lifecycle: lifecycleSummary(prepared.record),
      });
      return;
    }
    prepared.record.validation = {
      passed: true,
      variants: [],
      trainingTest: {
        passed: true,
        validatedAt: telemetry.finishedAt,
        stepIds: telemetry.steps.map((step) => step.stepId),
        llmCalls: 0,
        openAIRequests: 0,
      },
    };
    prepared.record.state = transitionWorkflow(
      prepared.record.state,
      "Validated",
      true,
    );
    await persistLifecycle(prepared.record);
    res.json({
      status: "Training test passed — Draft marked Validated",
      telemetry,
      lifecycle: lifecycleSummary(prepared.record),
      llmCalls: 0,
      openAIRequests: 0,
    });
  } catch (error) {
    res.status(409).json({
      error: error instanceof Error ? error.message : String(error),
      llmCalls: 0,
      openAIRequests: 0,
    });
  }
});
app.post("/api/lab/run-status", (req, res) => {
  const profileId = StudioProfileIdSchema.safeParse(req.body.studioProfileId);
  if (
    !profileId.success ||
    profileId.data !== "ncba-dpi-training" ||
    !isLabAuthorized(req.body.labSessionToken, profileId.data)
  ) {
    res.status(403).json({
      error: "Active non-clinical LAB MODE Training session required.",
    });
    return;
  }
  res.json(
    labRunProgress.get(profileId.data) ?? {
      running: false,
      updatedAt: new Date().toISOString(),
    },
  );
});
app.post("/api/lab/run", async (req, res) => {
  const profileId = StudioProfileIdSchema.safeParse(req.body.studioProfileId);
  if (
    !profileId.success ||
    profileId.data !== "ncba-dpi-training" ||
    !isLabAuthorized(req.body.labSessionToken, profileId.data)
  ) {
    res.status(403).json({
      error: "Active non-clinical LAB MODE Training session required.",
    });
    return;
  }
  if (activeLabRuns.has(profileId.data)) {
    res.status(409).json({ error: "A Lab run is already in progress." });
    return;
  }
  const controller = new AbortController();
  activeLabRuns.set(profileId.data, controller);
  labRunProgress.set(profileId.data, {
    running: true,
    current: {
      stepId: "pending",
      phase: "locator-resolution",
      label: "Resolving target",
    },
    updatedAt: new Date().toISOString(),
  });
  try {
    const prepared = await prepareLockedTrainingExecution(
      String(req.body.workflowId ?? ""),
      ["Draft", "Validated"],
    );
    const plannedActions = prepared.plannedActions;
    const telemetry = await runWorkflowOnExistingPage({
      page: prepared.session.primaryPage,
      workflow: prepared.record.workflow,
      expectedOrigin: prepared.session.applicationOrigin,
      signal: controller.signal,
      labMode: true,
      onProgress: (current) => {
        labRunProgress.set(profileId.data, {
          running: true,
          current,
          updatedAt: new Date().toISOString(),
        });
      },
    });
    const passed =
      telemetry.steps.length === prepared.record.workflow.steps.length &&
      telemetry.steps.every((step) => step.status === "passed");
    if (!passed) {
      res.status(422).json({
        error: controller.signal.aborted
          ? "Lab run stopped by operator."
          : "Lab run stopped at the first failed step.",
        plannedActions,
        telemetry,
        lifecycle: lifecycleSummary(prepared.record),
      });
      return;
    }
    if (prepared.record.state === "Draft") {
      prepared.record.validation = {
        passed: true,
        variants: [],
        trainingTest: {
          passed: true,
          validatedAt: telemetry.finishedAt,
          stepIds: telemetry.steps.map((step) => step.stepId),
          llmCalls: 0,
          openAIRequests: 0,
        },
      };
      prepared.record.state = "Validated";
      await persistLifecycle(prepared.record);
    }
    res.json({
      status: "Lab run passed — ready to run again",
      plannedActions,
      telemetry,
      lifecycle: lifecycleSummary(prepared.record),
      llmCalls: 0,
      openAIRequests: 0,
    });
  } catch (error) {
    res.status(409).json({
      error: error instanceof Error ? error.message : String(error),
      llmCalls: 0,
      openAIRequests: 0,
    });
  } finally {
    activeLabRuns.delete(profileId.data);
    const current = labRunProgress.get(profileId.data)?.current;
    labRunProgress.set(profileId.data, {
      running: false,
      ...(current ? { current } : {}),
      updatedAt: new Date().toISOString(),
    });
  }
});
app.post("/api/lab/stop", async (req, res) => {
  const profileId = StudioProfileIdSchema.safeParse(req.body.studioProfileId);
  if (
    !profileId.success ||
    !isLabAuthorized(req.body.labSessionToken, profileId.data)
  ) {
    res.status(403).json({ error: "Active LAB MODE session required." });
    return;
  }
  const controller = activeLabRuns.get(profileId.data);
  controller?.abort();
  const session = managedSessions.get(profileId.data);
  await session?.primaryPage
    .evaluate(() => window.stop())
    .catch(() => undefined);
  res.json({
    stopped: Boolean(controller),
    sessionPreserved: true,
    llmCalls: 0,
    openAIRequests: 0,
  });
});
app.post("/api/workflows/:workflowId/validate", async (req, res) => {
  const record = lifecycleRecords.get(req.params.workflowId);
  if (!record) {
    res.status(404).json({ error: "Workflow lifecycle record not found." });
    return;
  }
  if (record.state !== "Draft") {
    res.status(409).json({ error: "Only a Draft can be validated." });
    return;
  }
  const variants: Array<{ variant: "A" | "B"; passed: boolean }> = [];
  try {
    for (const variant of ["A", "B"] as const) {
      const telemetry = await runCompiledWorkflow({
        workflowPath: workflowArtifactPath(record.workflow.id),
        url: fixtureUrl(internalDemoUrl, variant),
        headless: true,
      });
      variants.push({
        variant,
        passed: telemetry.steps.every((step) => step.status === "passed"),
      });
    }
    const passed = variants.every((variant) => variant.passed);
    record.validation = { passed, variants };
    record.state = transitionWorkflow(record.state, "Validated", passed);
    await persistLifecycle(record);
    res.json({ lifecycle: lifecycleSummary(record) });
  } catch (error) {
    record.validation = { passed: false, variants };
    res.status(422).json({
      error: error instanceof Error ? error.message : String(error),
      lifecycle: lifecycleSummary(record),
    });
  }
});
app.post("/api/workflows/:workflowId/approve", async (req, res) => {
  const record = lifecycleRecords.get(req.params.workflowId);
  if (!record) {
    res.status(404).json({ error: "Workflow lifecycle record not found." });
    return;
  }
  if (req.body.confirmed !== true) {
    res.status(400).json({ error: "Explicit human approval is required." });
    return;
  }
  try {
    record.state = transitionWorkflow(record.state, "Approved");
    record.approvalTimestamp = new Date().toISOString();
    await persistLifecycle(record);
    res.json({ lifecycle: lifecycleSummary(record) });
  } catch (error) {
    res
      .status(409)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/workflows/:workflowId/promote", async (req, res) => {
  const record = lifecycleRecords.get(req.params.workflowId);
  if (!record) {
    res.status(404).json({ error: "Workflow lifecycle record not found." });
    return;
  }
  const capture = record.captureId ? captures.get(record.captureId) : undefined;
  if (!capture || !record.validation?.passed || !record.approvalTimestamp) {
    res.status(409).json({
      error:
        "Promotion requires the original capture, passed validation, and human approval.",
    });
    return;
  }
  try {
    const promotionTimestamp = new Date().toISOString();
    const unsigned: Omit<PromotedWorkflow, "workflowSha256"> = {
      workflowId: record.workflow.id,
      workflowVersion: record.workflow.version,
      applicationProfileId: localFixtureProfile.id,
      state: "Promoted",
      allowedRuntimeOrigins: [new URL(internalDemoUrl).origin],
      allowedPaths: ["/ncba-fixture"],
      structuralFingerprint: capture.fingerprint,
      fingerprintVersion: capture.fingerprint.version,
      compileModel: record.workflow.compileModel,
      promptVersion: "visual-compiler-v1",
      compiledFromSyntheticData: true,
      syntheticAttestationTimestamp: capture.attestedAt,
      selectedLocators: record.workflow.steps
        .map((step) => step.selectedLocator?.primary)
        .filter((locator): locator is string => Boolean(locator)),
      fallbackLocators: record.workflow.steps
        .map((step) => step.selectedLocator?.fallback)
        .filter((locator): locator is string => Boolean(locator)),
      preconditions: record.workflow.steps.flatMap((step) =>
        step.preconditions.map((condition) => condition.target),
      ),
      postconditions: record.workflow.steps.flatMap((step) =>
        step.postconditions.map((condition) => condition.target),
      ),
      confidence: Math.min(
        ...record.workflow.steps.map(
          (step) => step.selectedLocator?.confidence ?? 0,
        ),
      ),
      approvalTimestamp: record.approvalTimestamp,
      promotionTimestamp,
      runtimeOpenAIPolicy: "forbidden",
    };
    record.state = transitionWorkflow(
      record.state,
      "Promoted",
      record.validation.passed,
    );
    record.promotion = {
      ...unsigned,
      workflowSha256: computeWorkflowHash(unsigned),
    };
    await persistLifecycle(record);
    res.json({ lifecycle: lifecycleSummary(record) });
  } catch (error) {
    res
      .status(409)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/workflows/:workflowId/preflight", async (req, res) => {
  const record = lifecycleRecords.get(req.params.workflowId);
  if (!record?.promotion || record.state !== "Promoted") {
    res
      .status(409)
      .json({ error: "Only a Promoted workflow can run preflight." });
    return;
  }
  try {
    const runtimeUrl = fixtureUrl(internalDemoUrl, "A", "clinical");
    const currentPageModel = await captureLocalFixture(runtimeUrl);
    const currentFingerprint = createStructuralFingerprint(
      redactCapturedPageModel(currentPageModel),
    );
    const result = clinicalPreflight({
      workflow: record.promotion,
      profile: fixtureApplicationProfile(),
      url: runtimeUrl,
      actualFingerprint: currentFingerprint,
      targetsUnique: record.validation?.passed === true,
      preconditionsPassed: record.validation?.passed === true,
      humanConfirmed: req.body.confirmed === true,
    });
    record.lastPreflight = result;
    res.status(result.allowed ? 200 : 409).json({
      preflight: result,
      lifecycle: lifecycleSummary(record),
      plannedActions: record.workflow.steps.map((step) => ({
        stepId: step.id,
        action: step.action,
        intent: step.intent,
      })),
      llmCalls: 0,
      openAIRequests: 0,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/workflows/:workflowId/run-promoted", async (req, res) => {
  const record = lifecycleRecords.get(req.params.workflowId);
  if (
    !record?.promotion ||
    record.state !== "Promoted" ||
    !record.lastPreflight?.allowed
  ) {
    res.status(409).json({
      error: "A successful visible preflight is required before execution.",
    });
    return;
  }
  try {
    const variant = req.body.variant === "B" ? "B" : "A";
    const runtimeUrl = fixtureUrl(internalDemoUrl, variant, "clinical");
    const startedAt = new Date().toISOString();
    const telemetry = await runCompiledWorkflow({
      workflowPath: workflowArtifactPath(record.workflow.id),
      url: runtimeUrl,
      headless: true,
    });
    const audit = createRedactedAudit({
      workflow: record.promotion,
      origin: runtimeUrl,
      structuralCompatibility: record.lastPreflight.structuralCompatibility,
      startTime: startedAt,
      endTime: new Date().toISOString(),
      stepIds: telemetry.steps.map((step) => step.stepId),
      actionTypes: telemetry.steps.map((step) => step.action),
      stepResults: telemetry.steps.map((step) => step.status),
      errors: telemetry.steps
        .filter((step) => step.status === "failed")
        .map((step) => step.message),
    });
    res.json({
      telemetry,
      audit,
      workflowApproved: true,
      structuralCompatibility: record.lastPreflight.structuralCompatibility,
      llmCalls: 0,
      openAIRequests: 0,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/workflows/:workflowId/revoke", async (req, res) => {
  const record = lifecycleRecords.get(req.params.workflowId);
  if (!record) {
    res.status(404).json({ error: "Workflow lifecycle record not found." });
    return;
  }
  try {
    record.state = transitionWorkflow(record.state, "Revoked");
    await persistLifecycle(record);
    res.json({ lifecycle: lifecycleSummary(record) });
  } catch (error) {
    res
      .status(409)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/run", async (req, res) => {
  try {
    await ensureWorkflowStorage();
    const variant = req.body.variant === "B" ? "B" : "A";
    const visible = req.body.visible === true;
    const workflowId =
      typeof req.body.workflowId === "string"
        ? req.body.workflowId
        : defaultWorkflowId;
    const selectedWorkflowPath = workflowArtifactPath(workflowId);
    if (!existsSync(selectedWorkflowPath)) {
      res.status(404).json({ error: "Workflow artifact not found." });
      return;
    }
    const telemetry = await runCompiledWorkflow({
      workflowPath: selectedWorkflowPath,
      url: demoUrl(internalDemoUrl, variant),
      headless: !visible,
      slowMo: visible ? 500 : 0,
      keepOpenMs: visible ? 4_000 : 0,
    });
    res.json({ telemetry });
  } catch (error) {
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/api/workflows", async (_req, res) => {
  try {
    res.json({ workflows: await listWorkflowArtifacts() });
  } catch (error) {
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/api/workflow", async (req, res) => {
  try {
    const workflowId =
      typeof req.query.id === "string" ? req.query.id : defaultWorkflowId;
    const artifact = await readWorkflowArtifact(workflowId);
    res.json(artifact.workflow);
  } catch {
    res.status(404).json({ error: "No compiled workflow yet." });
  }
});

await hydrateLifecycleRecords();
const server = app.listen(port, host, () =>
  console.log(`Studio listening on http://${host}:${port}`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void Promise.all(
      [...managedSessions.values()].map(async (session) => {
        await session.context.close().catch(() => undefined);
        await session.browser.close().catch(() => undefined);
      }),
    ).finally(() => {
      managedSessions.clear();
      server.close(() => process.exit(0));
    });
  });
}
