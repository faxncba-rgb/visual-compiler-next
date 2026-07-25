import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { extractPageModel, type PageModel } from "@visual-compiler/page-model";
import {
  generateCandidates,
  selectBestCandidate,
} from "@visual-compiler/locator-engine";
import {
  SemanticWorkflowSchema,
  type SemanticStep,
  type SemanticWorkflow,
} from "@visual-compiler/semantic-ir";
import { canonicalizeTargetUrl, nowIso } from "@visual-compiler/shared";
import { generatePlaywrightSource } from "./codegen.js";
import { interpretInstruction } from "./interpreter.js";

export type CompileOptions = {
  instruction: string;
  url: string;
  outPath?: string;
  outDir?: string;
  headless?: boolean;
  pageModel?: PageModel;
  interpreter?: typeof interpretInstruction;
};

export function createWorkflowIdentity(
  instruction: string,
  suffix = randomUUID().replaceAll("-", "").slice(0, 8),
) {
  const normalized = instruction.trim().replace(/\s+/g, " ");
  const slug =
    normalized
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 52)
      .replace(/-+$/g, "") || "workflow";
  const title = normalized.slice(0, 96).trim() || "Workflow";
  return {
    id: `${slug}-${suffix}`,
    name: `${title} [${suffix}]`,
  };
}

export async function compileWorkflow(
  options: CompileOptions,
): Promise<SemanticWorkflow> {
  if (options.outPath && options.outDir) {
    throw new Error("Specify either outPath or outDir, not both.");
  }
  const started = Date.now();
  const identity = createWorkflowIdentity(options.instruction);
  let pageModel = options.pageModel;
  if (!pageModel) {
    const browser = await chromium.launch({
      headless: options.headless ?? true,
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 820 },
    });
    try {
      await page.goto(options.url);
      pageModel = await extractPageModel(page);
    } finally {
      await browser.close();
    }
  }
  const canonicalUrl = canonicalizeTargetUrl(pageModel.url);
  const compilerPageModel: PageModel = {
    ...pageModel,
    url: canonicalUrl,
  };

  const interpretation = await (options.interpreter ?? interpretInstruction)(
    options.instruction,
    compilerPageModel,
  );
  const steps = interpretation.result.steps.map((step) => {
    const candidates = generateCandidates(
      compilerPageModel,
      step as SemanticStep,
    );
    const selected = selectBestCandidate(candidates);
    return {
      ...step,
      candidates,
      selectedLocator: {
        kind: "semantic-rule" as const,
        primary: selected.selector,
        fallback: candidates[1]?.selector,
        rule: {
          anchorText: step.target.relations[0]?.anchorText,
          candidateRole: step.target.role as
            | "checkbox"
            | "button"
            | "textbox"
            | "combobox"
            | "option"
            | "link"
            | undefined,
          candidateText: step.target.accessibleName,
          relation:
            step.target.relations[0]?.relation === "next-to"
              ? "nearest"
              : (step.target.relations[0]?.relation as
                  | "right-of"
                  | "left-of"
                  | "below"
                  | "above"
                  | "same-row"
                  | "same-column"
                  | "nearest"),
          ordinal: step.target.ordinal ?? 1,
          enabledOnly: step.target.state === "enabled",
          visibleOnly: true,
          color: step.target.iconColor,
        },
        confidence: selected.confidence,
        explanation: selected.explanation,
      },
    };
  });

  const workflowWithoutCode = {
    id: identity.id,
    version: "0.1.0",
    name: identity.name,
    source: { url: canonicalUrl, viewport: compilerPageModel.viewport },
    steps,
    compiledAt: nowIso(),
    compileModel: process.env.OPENAI_COMPILE_MODEL ?? "gpt-5.6",
    metadata: {
      compilerVersion: "0.1.0",
      targetUrl: canonicalUrl,
      validationVariant:
        new URL(canonicalUrl).searchParams.get("variant") ?? undefined,
    },
    diagnostics: {
      modelCalls: interpretation.modelCalls,
      interpretationSource: interpretation.source,
      responseModel: interpretation.responseModel,
      tokenUsage: interpretation.tokenUsage,
      warnings: interpretation.result.ambiguityWarnings,
      durationMs: Date.now() - started,
      rejected: false,
    },
  };
  const workflow = SemanticWorkflowSchema.parse({
    ...workflowWithoutCode,
    generatedPlaywright: generatePlaywrightSource(workflowWithoutCode),
  });

  const artifactPath = options.outDir
    ? path.join(options.outDir, `${workflow.id}.json`)
    : options.outPath;
  if (artifactPath) {
    await mkdir(path.dirname(artifactPath), { recursive: true });
    const temporaryPath = path.join(
      path.dirname(artifactPath),
      `${path.basename(artifactPath)}.${randomUUID()}.tmp.json`,
    );
    try {
      await writeFile(temporaryPath, JSON.stringify(workflow, null, 2));
      try {
        await link(temporaryPath, artifactPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Workflow artifact already exists: ${artifactPath}`);
        }
        throw error;
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
  return workflow;
}

export {
  createRedactedCompilerPageModel,
  InterpreterResponseSchema,
  interpreterResponseFormat,
  mockInterpretInstruction,
  interpretInstructionWithOpenAI,
} from "./interpreter.js";
