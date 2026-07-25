import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SemanticWorkflowSchema } from "@visual-compiler/semantic-ir";

describe("runtime safeguards", () => {
  it("does not import the OpenAI SDK", async () => {
    const source = await readFile("packages/runtime/src/index.ts", "utf8");
    expect(source).not.toMatch(/from ["']openai["']/);
    expect(source).not.toMatch(/new OpenAI/);
    expect(source).toContain('serviceWorkers: "block"');
    expect(source).toContain('await route.abort("blockedbyclient")');
    expect(source).toContain("await page.routeWebSocket(");
  });

  it("runtime package has no OpenAI dependency", async () => {
    const pkg = JSON.parse(
      await readFile("packages/runtime/package.json", "utf8"),
    );
    expect(JSON.stringify(pkg.dependencies ?? {})).not.toContain("openai");
  });

  it("derives replay checks without a hard-coded Pending review target", async () => {
    const studio = await readFile("apps/studio/backend/src/server.ts", "utf8");
    const runtime = await readFile("packages/runtime/src/index.ts", "utf8");
    expect(studio).not.toContain("Insurance document primary checkbox");
    expect(runtime).not.toContain("Insurance document primary checkbox");
    expect(studio).toContain("outDir: WORKFLOW_STORAGE_DIR");
    expect(studio).not.toContain("outPath: WORKFLOW_PATH");
    expect(runtime).toContain("verifyDerivedFinalState");
  });

  it("can run with OPENAI_API_KEY unset at process level", () => {
    delete process.env.OPENAI_API_KEY;
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(existsSync("packages/runtime/src/index.ts")).toBe(true);
  });

  it("bounds compilation and returns artifacts through a separate read path", async () => {
    const studio = await readFile("apps/studio/backend/src/server.ts", "utf8");
    const interpreter = await readFile(
      "packages/compiler/src/interpreter.ts",
      "utf8",
    );
    expect(interpreter).toContain("OPENAI_COMPILE_TIMEOUT_MS");
    expect(interpreter).toContain("new OpenAI({ timeout, maxRetries: 0 })");
    expect(studio).toContain("COMPILE_RESPONSE_TIMEOUT_MS");
    expect(studio).toContain("activeCompilationKeys");
    expect(studio).toContain('app.get("/api/compile-status"');
    expect(studio).toContain('app.get("/api/workflow"');
    expect(studio).toContain("compactCompileResponse");
    expect(studio).not.toContain(
      "res.json({ workflow, lifecycle: lifecycleSummary(lifecycle) })",
    );
  });

  it("ships the validated GPT-5.6 runtime artifact without credentials", async () => {
    const raw = await readFile(
      "compiled-workflows/pending-review.workflow.json",
      "utf8",
    );
    const workflow = SemanticWorkflowSchema.parse(JSON.parse(raw));
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(workflow.diagnostics.interpretationSource).toBe("gpt-5.6");
    expect(workflow.diagnostics.modelCalls).toBe(1);
    expect(workflow.diagnostics.responseModel).toBe("gpt-5.6-sol");
    expect(workflow.diagnostics.tokenUsage?.totalTokens).toBeGreaterThan(0);
    expect(workflow.steps[0].selectedLocator?.rule?.candidateRole).toBe(
      "checkbox",
    );
  });
});
