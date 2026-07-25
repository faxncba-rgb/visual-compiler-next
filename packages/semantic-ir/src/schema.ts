import { z } from "zod";

export const SpatialRelationSchema = z.object({
  relation: z.enum([
    "next-to",
    "below",
    "above",
    "same-row",
    "same-column",
    "left-of",
    "right-of",
    "nearest",
    "first",
    "second",
  ]),
  anchorText: z.string().optional(),
  anchorRole: z.string().optional(),
  tolerancePx: z.number().min(0).max(80).default(24),
});

export const AssertionSchema = z.object({
  type: z.enum([
    "text-visible",
    "checkbox-state",
    "element-visible",
    "element-enabled",
  ]),
  target: z.string(),
  expected: z.union([z.string(), z.boolean()]).optional(),
});

export const LocatorCandidateSchema = z.object({
  strategy: z.enum([
    "role-name",
    "label-association",
    "text-dom-relation",
    "semantic-row-column",
    "test-attribute",
    "relative-dom",
    "spatial-bounds",
    "ocr-anchor",
    "image-template",
    "absolute-coordinate",
  ]),
  selector: z.string(),
  confidence: z.number().min(0).max(1),
  unique: z.boolean(),
  stability: z.number().min(0).max(1),
  explanation: z.string(),
  fallbackOrder: z.number().int().min(0),
});

export const CompiledLocatorSchema = z.object({
  kind: z.enum(["playwright", "semantic-rule"]),
  primary: z.string(),
  fallback: z.string().optional(),
  rule: z
    .object({
      anchorText: z.string().optional(),
      anchorRole: z.string().optional(),
      candidateRole: z
        .enum(["checkbox", "button", "textbox", "combobox", "option", "link"])
        .optional(),
      candidateText: z.string().optional(),
      relation: z
        .enum([
          "right-of",
          "left-of",
          "below",
          "above",
          "same-row",
          "same-column",
          "nearest",
        ])
        .optional(),
      ordinal: z.number().int().min(1).default(1),
      enabledOnly: z.boolean().default(true),
      visibleOnly: z.boolean().default(true),
      color: z.enum(["green", "red", "neutral", "warning"]).optional(),
    })
    .optional(),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
});

export const SemanticTargetSchema = z.object({
  elementType: z.string().optional(),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  anchorText: z.string().optional(),
  iconColor: z.enum(["green", "red", "neutral", "warning"]).optional(),
  ordinal: z.number().int().positive().optional(),
  state: z.enum(["enabled", "disabled", "checked", "unchecked"]).optional(),
  relations: z.array(SpatialRelationSchema).default([]),
});

export const SemanticStepSchema = z.object({
  id: z.string(),
  action: z.enum([
    "click",
    "check",
    "uncheck",
    "fill",
    "select",
    "wait",
    "assert",
  ]),
  intent: z.string(),
  target: SemanticTargetSchema,
  value: z.string().optional(),
  preconditions: z.array(AssertionSchema).default([]),
  postconditions: z.array(AssertionSchema).default([]),
  candidates: z.array(LocatorCandidateSchema).default([]),
  selectedLocator: CompiledLocatorSchema.optional(),
});

export const CompilationDiagnosticsSchema = z.object({
  modelCalls: z.number().int().min(0),
  interpretationSource: z.enum(["gpt-5.6", "mock", "precompiled-sample"]),
  responseModel: z.string().optional(),
  tokenUsage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      reasoningTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    })
    .optional(),
  warnings: z.array(z.string()).default([]),
  locatorDiagnostics: z
    .array(
      z.object({
        stepId: z.string(),
        candidateCount: z.number().int().nonnegative(),
        selectedStrategy: LocatorCandidateSchema.shape.strategy.optional(),
        zeroCandidateReason: z.string().optional(),
      }),
    )
    .default([]),
  durationMs: z.number().min(0),
  rejected: z.boolean().default(false),
});

export const RuntimeTelemetrySchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().min(0).optional(),
  llmCalls: z.literal(0),
  openAIRequests: z.literal(0),
  finalState: z
    .object({
      checks: z.array(
        z.object({
          kind: z.enum([
            "checkbox-state",
            "input-value",
            "select-value",
            "text-visible",
            "element-visible",
            "element-enabled",
          ]),
          target: z.string(),
          expected: z.union([z.string(), z.boolean()]),
          actual: z.union([z.string(), z.boolean()]),
          passed: z.literal(true),
        }),
      ),
    })
    .optional(),
  steps: z.array(
    z.object({
      stepId: z.string(),
      action: z.string(),
      status: z.enum(["passed", "failed"]),
      durationMs: z.number().min(0),
      message: z.string().optional(),
    }),
  ),
});

export const SemanticWorkflowSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  source: z.object({
    url: z.string(),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
  steps: z.array(SemanticStepSchema).min(1),
  generatedPlaywright: z.string(),
  compiledAt: z.string(),
  compileModel: z.string(),
  metadata: z.object({
    compilerVersion: z.string(),
    targetUrl: z.string(),
    validationVariant: z.string().optional(),
  }),
  diagnostics: CompilationDiagnosticsSchema,
});

export type SpatialRelation = z.infer<typeof SpatialRelationSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;
export type CompiledLocator = z.infer<typeof CompiledLocatorSchema>;
export type SemanticStep = z.infer<typeof SemanticStepSchema>;
export type SemanticWorkflow = z.infer<typeof SemanticWorkflowSchema>;
export type RuntimeTelemetry = z.infer<typeof RuntimeTelemetrySchema>;
