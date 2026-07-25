import express from "express";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
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
import { runCompiledWorkflow } from "@visual-compiler/runtime";
import {
  createStudioApplicationProfiles,
  clinicalPreflight,
  computeWorkflowHash,
  createRedactedAudit,
  createStructuralFingerprint,
  localFixtureProfile,
  redactPageModel,
  resolveStudioProfileTarget,
  requireValidAttestation,
  StudioProfileIdSchema,
  transitionWorkflow,
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
const defaultWorkflowId = path.basename(WORKFLOW_PATH, ".json");
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
  process.env.NCBA_TRAINING_ORIGIN ??
    "https://dpi-ncba.gbna-sante.fr",
  "NCBA_TRAINING_ORIGIN",
);
const allowExplicitLocalSsoFixture =
  process.env.ALLOW_EXPLICIT_LOCAL_SSO_FIXTURE === "true" &&
  ["127.0.0.1", "localhost"].includes(
    new URL(managedTrainingOrigin).hostname,
  );
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
type ManagedBrowserPhase =
  | "authentication-bootstrap"
  | "application-locked";
type ManagedBrowserSession = {
  id: string;
  browser: Browser;
  context: BrowserContext;
  primaryPage: Page;
  phase: ManagedBrowserPhase;
  applicationOrigin: string;
};
const managedSessions = new Map<StudioProfileId, ManagedBrowserSession>();
const captures = new Map<
  string,
  {
    id: string;
    studioProfileId: StudioProfileId;
    pageModel: PageModel;
    redactedModel: RedactedPageModel;
    fingerprint: StructuralFingerprint;
    attestedAt: string;
    managedSessionId?: string;
  }
>();
type LifecycleRecord = {
  workflow: SemanticWorkflow;
  state: WorkflowState;
  captureId: string;
  validation?: {
    passed: boolean;
    variants: Array<{ variant: "A" | "B"; passed: boolean }>;
  };
  approvalTimestamp?: string;
  promotion?: PromotedWorkflow;
  lastPreflight?: ReturnType<typeof clinicalPreflight>;
};
const lifecycleRecords = new Map<string, LifecycleRecord>();

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

async function ensureWorkflowStorage() {
  await mkdir(WORKFLOW_STORAGE_DIR, { recursive: true });
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
    headless: false,
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
    await primaryPage.goto(target.toString());
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

async function lockManagedBrowserToApplication(
  session: ManagedBrowserSession,
) {
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
      canLockAuthentication: false
    };
    const output = document.getElementById("output");
    const workflowSelect = document.getElementById("workflow");
    const profileSelect = document.getElementById("applicationProfile");
    const targetUrl = document.getElementById("targetUrl");
    const compileButton = document.getElementById("compile");
    const captureButton = document.getElementById("capture");
    const attestationInputs = Array.from(document.querySelectorAll("[data-attestation-key]"));
    const indicatorVerified = document.getElementById("indicatorVerified");
    const controls = Array.from(document.querySelectorAll("button, select, input, textarea"));
    let targetValidationTimer;
    let authenticationPollTimer;
    const variantUrl = variant => publicDemoUrl + "/demo?variant=" + variant;
    const lifecycleOrder = ["Draft", "Validated", "Approved", "Promoted", "Revoked"];
    const attestationComplete = () =>
      attestationInputs.every(input => input.checked) && indicatorVerified.checked;
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
        state.profile.mode === "clinical" ||
        !state.profile.compilationAllowed ||
        !attested ||
        !state.targetValid ||
        !managedApplicationReady ||
        !state.capture;
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
    };
    const setBusy = busy => {
      controls.forEach(control => { control.disabled = busy; });
      if (!busy) syncJourneyControls();
    };
    const setStatus = (text, cls = "warn") => { const el = document.getElementById("status"); el.textContent = text; el.className = cls; };
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
      document.getElementById("trainingControls").classList.toggle("hidden", profile.mode === "clinical");
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
      document.getElementById("compileModel").textContent = workflow.diagnostics.responseModel ?? workflow.compileModel;
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
    const refreshWorkflowList = async preferredId => {
      const response = await fetch("/api/workflows");
      if (!response.ok) throw new Error("Unable to list workflow artifacts.");
      const json = await response.json();
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
      const response = await fetch("/api/workflow?id=" + encodeURIComponent(workflowId));
      if (!response.ok) throw new Error("Unable to load workflow artifact.");
      applyWorkflow(await response.json());
    };
    const render = () => {
      if (!state.workflow) { output.textContent = "No workflow loaded."; return; }
      if (state.tab === "ir") output.textContent = JSON.stringify(state.workflow, null, 2);
      if (state.tab === "locators") output.textContent = JSON.stringify(state.workflow.steps.map(s => ({ id: s.id, intent: s.intent, candidates: s.candidates, selectedLocator: s.selectedLocator })), null, 2);
      if (state.tab === "code") output.textContent = state.workflow.generatedPlaywright;
      if (state.tab === "log") output.textContent = JSON.stringify(state.telemetry ?? { message: "Run workflow to collect telemetry." }, null, 2);
      document.querySelectorAll("[data-tab]").forEach(button => button.setAttribute("aria-selected", String(button.dataset.tab === state.tab)));
    };
    const requestJson = async (url, body) => {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await response.json();
      if (!response.ok) throw Object.assign(new Error(json.error ?? "Request failed."), { response: json });
      return json;
    };
    document.querySelectorAll("[data-tab]").forEach(btn => btn.addEventListener("click", () => { state.tab = btn.dataset.tab; render(); }));
    document.getElementById("variant").addEventListener("change", event => {
      if (state.profile.id === "ncba-dpi-fixture") {
        document.getElementById("demo").src = variantUrl(event.target.value);
      }
    });
    document.getElementById("capture").addEventListener("click", async () => {
      setBusy(true);
      setStatus("Capturing redacted page model");
      try {
        const json = await requestJson("/api/capture", {
          studioProfileId: state.profile.id,
          targetUrl: targetUrl.value,
          syntheticAttestation: syntheticAttestation()
        });
        state.capture = json;
        document.getElementById("redactionReport").textContent = JSON.stringify({
          ...json.redactionReport,
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
        setStatus("Redacted capture ready", "ok");
      } catch (error) {
        state.capture = null;
        setStatus("Capture failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
        setBusy(false);
      }
    });
    document.getElementById("compile").addEventListener("click", async () => {
      setBusy(true);
      setStatus("Compiling");
      try {
        const variant = document.getElementById("variant").value;
        const json = await requestJson("/api/compile", {
          instruction: document.getElementById("instruction").value,
          variant,
          studioProfileId: state.profile.id,
          targetUrl: targetUrl.value,
          captureId: state.capture?.captureId,
          syntheticAttestation: syntheticAttestation()
        });
        await refreshWorkflowList(json.workflow.id);
        applyWorkflow(json.workflow);
        state.lifecycle = json.lifecycle;
        state.preflight = null;
        renderLifecycle();
        setStatus("Compiled — Draft", "ok");
      } catch (error) {
        setStatus("Failed", "error");
        output.textContent = JSON.stringify(error.response ?? { error: error.message }, null, 2);
      } finally {
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
          syntheticAttestation: syntheticAttestation()
        });
        renderAuthenticationState(result);
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
    [...attestationInputs, indicatorVerified].forEach(input => {
      input.addEventListener("change", syncJourneyControls);
    });
    targetUrl.addEventListener("input", () => {
      state.targetValid = false;
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
    if (resolved.profile.syntheticAttestationRequired) {
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
      status:
        "AUTHENTICATION IN PROGRESS — capture and compilation disabled",
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
  let attestation;
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
      crossOriginFramesExcluded = page
        .frames()
        .filter((frame) => {
          if (frame === page.mainFrame()) return false;
          try {
            return new URL(frame.url()).origin !== session.applicationOrigin;
          } catch {
            return true;
          }
        }).length;
      pageModel = await extractPageModel(page);
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
    const id = randomUUID();
    captures.set(id, {
      id,
      studioProfileId: studioProfile.id,
      pageModel,
      redactedModel,
      fingerprint,
      attestedAt: attestation.attestedAt,
      managedSessionId,
    });
    const compilerBoundary = createRedactedCompilerPageModel(pageModel);
    res.json({
      captureId: id,
      profileId: studioProfile.id,
      redactionReport: redactedModel.report,
      compilerBoundaryReport: compilerBoundary.redactionReport,
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
app.post("/api/compile", async (req, res) => {
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
  try {
    const managedSession = studioProfile.managedBrowserOnly
      ? managedSessions.get(studioProfile.id)
      : undefined;
    if (
      studioProfile.managedBrowserOnly &&
      (!managedSession || managedSession.phase !== "application-locked")
    ) {
      res.status(423).json({
        error:
          "AUTHENTICATION IN PROGRESS — capture and compilation disabled.",
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
    const compilerPageModel: PageModel = {
      ...capture.pageModel,
      url: canonicalizeTargetUrl(capture.pageModel.url),
    };
    const workflow = await compileWorkflow({
      instruction,
      url: compilerPageModel.url,
      outDir: WORKFLOW_STORAGE_DIR,
      pageModel: compilerPageModel,
    });
    const lifecycle: LifecycleRecord = {
      workflow,
      state: "Draft",
      captureId: capture.id,
    };
    lifecycleRecords.set(workflow.id, lifecycle);
    res.json({ workflow, lifecycle: lifecycleSummary(lifecycle) });
  } catch (error) {
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/api/workflow-lifecycle", (req, res) => {
  const workflowId = typeof req.query.id === "string" ? req.query.id : "";
  const record = lifecycleRecords.get(workflowId);
  if (!record) {
    res.status(404).json({ error: "No lifecycle record for this workflow." });
    return;
  }
  res.json({ lifecycle: lifecycleSummary(record) });
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
    res.json({ lifecycle: lifecycleSummary(record) });
  } catch (error) {
    record.validation = { passed: false, variants };
    res.status(422).json({
      error: error instanceof Error ? error.message : String(error),
      lifecycle: lifecycleSummary(record),
    });
  }
});
app.post("/api/workflows/:workflowId/approve", (req, res) => {
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
    res.json({ lifecycle: lifecycleSummary(record) });
  } catch (error) {
    res
      .status(409)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/workflows/:workflowId/promote", (req, res) => {
  const record = lifecycleRecords.get(req.params.workflowId);
  if (!record) {
    res.status(404).json({ error: "Workflow lifecycle record not found." });
    return;
  }
  const capture = captures.get(record.captureId);
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
app.post("/api/workflows/:workflowId/revoke", (req, res) => {
  const record = lifecycleRecords.get(req.params.workflowId);
  if (!record) {
    res.status(404).json({ error: "Workflow lifecycle record not found." });
    return;
  }
  try {
    record.state = transitionWorkflow(record.state, "Revoked");
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
    res.json(
      JSON.parse(await readFile(workflowArtifactPath(workflowId), "utf8")),
    );
  } catch {
    res.status(404).json({ error: "No compiled workflow yet." });
  }
});

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
