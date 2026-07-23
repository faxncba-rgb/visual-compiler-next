import express from "express";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { compileWorkflow } from "@visual-compiler/compiler";
import { runCompiledWorkflow } from "@visual-compiler/runtime";
import {
  browserProfiles,
  localFixtureProfile,
  ncbaDpiProfile,
  requireValidAttestation,
  validateTargetUrl,
} from "@visual-compiler/clinical-safety";
import {
  DEFAULT_DEMO_INTERNAL_URL,
  DEFAULT_DEMO_PUBLIC_URL,
  DEFAULT_INSTRUCTION,
  WORKFLOW_PATH,
  WORKFLOW_STORAGE_DIR,
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

async function ensureWorkflowStorage() {
  await mkdir(WORKFLOW_STORAGE_DIR, { recursive: true });
  await access(WORKFLOW_STORAGE_DIR, constants.R_OK | constants.W_OK);
}

async function ensureBrowserProfileDirectory(mode: "training" | "clinical") {
  await mkdir(browserProfileRoot, { recursive: true, mode: 0o700 });
  await chmod(browserProfileRoot, 0o700);
  const profileDirectory = path.join(
    browserProfileRoot,
    browserProfiles[mode].storageDirectoryName,
  );
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await chmod(profileDirectory, 0o700);
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
    .attestation { display: grid; gap: 8px; margin-top: 12px; font-size: 13px; }
    .attestation label { display: grid; grid-template-columns: 22px 1fr; gap: 6px; align-items: start; }
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
      <section class="mode-panel" aria-label="Training Compilation">
        <div class="mode-title">TRAINING MODE</div>
        <strong>SYNTHETIC DATA ONLY</strong><br><strong>GPT-5.6 COMPILATION ENABLED</strong>
        <label for="targetUrl">Target Website URL</label>
        <input id="targetUrl" type="url" value="http://127.0.0.1:4173/ncba-fixture?mode=training&amp;variant=A">
        <div class="attestation" aria-label="Synthetic data attestation">
          <strong>I confirm that:</strong>
          <label><input type="checkbox"> <span>I am authorized to automate this training environment.</span></label>
          <label><input type="checkbox"> <span>This browser session contains synthetic data only.</span></label>
          <label><input type="checkbox"> <span>No real patient data is visible.</span></label>
          <label><input type="checkbox"> <span>No credential or secret may be sent to OpenAI.</span></label>
          <label><input type="checkbox"> <span>The workflow is administrative and reversible.</span></label>
        </div>
      </section>
      <h2>Instruction</h2>
      <textarea id="instruction" aria-label="Workflow instruction">${escapeHtml(DEFAULT_INSTRUCTION)}</textarea>
      <div class="row">
        <select id="workflow" aria-label="Compiled workflow"></select>
        <select id="variant" aria-label="Demo layout"><option value="A">Variant A</option><option value="B">Variant B</option></select>
        <button class="primary" id="compile">Compile</button>
        <button class="secondary" id="runA">Run A</button>
        <button class="secondary" id="runB">Run B</button>
      </div>
      <p class="hint">Run A/B opens a separate visible Chromium replay. The iframe remains an independent preview.</p>
      <section class="mode-panel clinical" aria-label="Clinical Runtime">
        <div class="mode-title">CLINICAL RUNTIME</div>
        <strong>OPENAI ACCESS FORBIDDEN</strong><br><strong>PROMOTED WORKFLOWS ONLY</strong>
        <label for="promotedWorkflow">Promoted workflow</label>
        <select id="promotedWorkflow" aria-label="Promoted workflow"><option>No promoted NCBA workflow</option></select>
        <p class="hint">Hash verification: pending<br>Structural compatibility: pending<br>Runtime LLM calls: 0<br>OpenAI requests: 0</p>
        <pre aria-label="Planned clinical actions">No actions — preflight required.</pre>
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
    const state = { workflow: null, telemetry: null, tab: "ir" };
    const output = document.getElementById("output");
    const workflowSelect = document.getElementById("workflow");
    const controls = Array.from(document.querySelectorAll("#workflow, #variant, #compile, #runA, #runB"));
    const variantUrl = variant => publicDemoUrl + "/demo?variant=" + variant;
    const setBusy = busy => controls.forEach(button => { button.disabled = busy; });
    const setStatus = (text, cls = "warn") => { const el = document.getElementById("status"); el.textContent = text; el.className = cls; };
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
    document.getElementById("variant").addEventListener("change", event => { document.getElementById("demo").src = variantUrl(event.target.value); });
    document.getElementById("compile").addEventListener("click", async () => {
      setBusy(true);
      setStatus("Compiling");
      try {
        const variant = document.getElementById("variant").value;
        const json = await requestJson("/api/compile", { instruction: document.getElementById("instruction").value, variant });
        await refreshWorkflowList(json.workflow.id);
        applyWorkflow(json.workflow);
        setStatus("Compiled", "ok");
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
    document.getElementById("clinicalStop").addEventListener("click", () => {
      setStatus("Clinical run stopped", "warn");
    });
    document.getElementById("deleteClinicalProfile").addEventListener("click", async () => {
      if (!window.confirm("Delete the independent local clinical browser profile?")) return;
      const response = await fetch("/api/browser-profiles/clinical", { method: "DELETE" });
      const result = await response.json();
      setStatus(response.ok ? result.status : result.error, response.ok ? "ok" : "error");
    });
    workflowSelect.addEventListener("change", () => {
      loadWorkflow(workflowSelect.value).catch(error => {
        setStatus("Failed", "error");
        output.textContent = JSON.stringify({ error: error.message }, null, 2);
      });
    });
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
  res.json({
    profiles: [localFixtureProfile, ncbaDpiProfile],
    browserProfiles,
  });
});
app.delete("/api/browser-profiles/:mode", async (req, res) => {
  const mode = req.params.mode;
  if (mode !== "training" && mode !== "clinical") {
    res.status(400).json({ error: "Unknown browser profile mode." });
    return;
  }
  const profileDirectory = path.join(
    browserProfileRoot,
    browserProfiles[mode].storageDirectoryName,
  );
  await rm(profileDirectory, { recursive: true, force: true });
  res.json({ status: `${mode} browser profile deleted` });
});
app.post("/api/browser-profiles/:mode/prepare", async (req, res) => {
  const mode = req.params.mode;
  if (mode !== "training" && mode !== "clinical") {
    res.status(400).json({ error: "Unknown browser profile mode." });
    return;
  }
  await ensureBrowserProfileDirectory(mode);
  res.json({
    status: `${mode} browser profile prepared`,
    permissions: "0700",
    compilationAllowed: browserProfiles[mode].compilationAllowed,
  });
});
app.post("/api/clinical/compile", (_req, res) => {
  res
    .status(403)
    .json({ error: "Compilation is technically disabled in clinical mode." });
});
app.post("/api/compile", async (req, res) => {
  try {
    if (req.body.mode === "clinical") {
      res.status(403).json({
        error: "Compilation is technically disabled in clinical mode.",
      });
      return;
    }
    if (req.body.applicationProfileId === "ncba-dpi") {
      requireValidAttestation(req.body.syntheticAttestation, ncbaDpiProfile);
      validateTargetUrl(String(req.body.targetUrl ?? ""), {
        mode: "training",
        profile: ncbaDpiProfile,
      });
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
    const variant = req.body.variant === "B" ? "B" : "A";
    const workflow = await compileWorkflow({
      instruction,
      url: demoUrl(internalDemoUrl, variant),
      outDir: WORKFLOW_STORAGE_DIR,
    });
    res.json({ workflow });
  } catch (error) {
    res
      .status(500)
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

app.listen(port, host, () =>
  console.log(`Studio listening on http://${host}:${port}`),
);
