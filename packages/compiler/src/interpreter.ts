import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { PageModel } from "@visual-compiler/page-model";
import { SemanticStepSchema } from "@visual-compiler/semantic-ir";
import {
  canonicalizeTargetUrl,
  DEFAULT_INSTRUCTION,
} from "@visual-compiler/shared";

export const InterpreterResponseSchema = z.object({
  name: z.string(),
  assumptions: z.array(z.string()).default([]),
  ambiguityWarnings: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  expectedResult: z.string(),
  steps: z
    .array(SemanticStepSchema.omit({ candidates: true, selectedLocator: true }))
    .min(1),
});

export type InterpreterResponse = z.infer<typeof InterpreterResponseSchema>;

export function createRedactedCompilerPageModel(model: PageModel) {
  const url = new URL(canonicalizeTargetUrl(model.url));
  return {
    origin: url.origin,
    path: url.pathname,
    viewport: model.viewport,
    nodes: model.nodes.map((node, structuralIndex) => ({
      structuralIndex,
      tagName: node.tagName,
      role: node.role,
      stableLabel: node.attributes["data-vc-stable-label"],
      controlType: node.attributes.type ?? node.tagName,
      box: node.box,
      visible: node.visible,
      enabled: node.enabled,
      checked: node.checked,
    })),
    redactionReport: {
      fieldsRemoved: model.nodes.reduce(
        (count, node) => count + Object.keys(node.attributes).length,
        0,
      ),
      valuesRemoved: model.nodes.reduce(
        (count, node) =>
          count +
          Number(Boolean(node.text)) +
          Number(Boolean(node.accessibleName)),
        0,
      ),
      sensitiveNodesRemoved: 0,
      cookiesCaptured: false as const,
      storageCaptured: false as const,
      networkCaptured: false as const,
    },
  };
}

const InterpreterRelationSchema = z.object({
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
  anchorText: z.string().nullable(),
  anchorRole: z.string().nullable(),
  tolerancePx: z.number().min(0).max(80),
});

const InterpreterAssertionSchema = z.object({
  type: z.enum([
    "text-visible",
    "checkbox-state",
    "element-visible",
    "element-enabled",
  ]),
  target: z.string(),
  expected: z.union([z.string(), z.boolean()]).nullable(),
});

const InterpreterTargetSchema = z.object({
  elementType: z.string().nullable(),
  role: z.string().nullable(),
  accessibleName: z.string().nullable(),
  anchorText: z.string().nullable(),
  iconColor: z.enum(["green", "red", "neutral", "warning"]).nullable(),
  ordinal: z.number().int().positive().nullable(),
  state: z.enum(["enabled", "disabled", "checked", "unchecked"]).nullable(),
  relations: z.array(InterpreterRelationSchema),
});

const InterpreterStructuredResponseSchema = z.object({
  name: z.string(),
  assumptions: z.array(z.string()),
  ambiguityWarnings: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  expectedResult: z.string(),
  steps: z
    .array(
      z.object({
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
        target: InterpreterTargetSchema,
        value: z.string().nullable(),
        preconditions: z.array(InterpreterAssertionSchema),
        postconditions: z.array(InterpreterAssertionSchema),
      }),
    )
    .min(1),
});

export const interpreterResponseFormat = zodTextFormat(
  InterpreterStructuredResponseSchema,
  "visual_compiler_interpretation",
);

function removeNullObjectFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeNullObjectFields);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, fieldValue]) => fieldValue !== null)
        .map(([key, fieldValue]) => [key, removeNullObjectFields(fieldValue)]),
    );
  }
  return value;
}

function normalizeInstruction(instruction: string) {
  return instruction.trim().replace(/\s+/g, " ");
}

export function mockInterpretInstruction(
  instruction = DEFAULT_INSTRUCTION,
): InterpreterResponse {
  if (
    normalizeInstruction(instruction) !==
    normalizeInstruction(DEFAULT_INSTRUCTION)
  ) {
    throw new Error(
      "The offline mock interpreter supports only the documented Pending review fixture. Enable live compilation for other instructions.",
    );
  }
  return InterpreterResponseSchema.parse({
    name: "Pending review approval",
    assumptions: [
      "The first enabled checkbox to the right is selected in visual row order.",
    ],
    ambiguityWarnings: [
      "There are repeated Pending review labels; table row geometry disambiguates the target.",
    ],
    confidence: 0.91,
    expectedResult:
      "The enabled Pending review checkbox is checked and the confirmation status appears.",
    steps: [
      {
        id: "step-1",
        action: "check",
        intent:
          "Check the first enabled checkbox to the right of the Pending review status text.",
        target: {
          role: "checkbox",
          state: "enabled",
          ordinal: 1,
          relations: [
            {
              relation: "right-of",
              anchorText: "Pending review",
              tolerancePx: 24,
            },
          ],
        },
        preconditions: [
          {
            type: "element-enabled",
            target: "Pending review row checkbox",
            expected: true,
          },
        ],
        postconditions: [
          {
            type: "checkbox-state",
            target: "Pending review row checkbox",
            expected: true,
          },
        ],
      },
      {
        id: "step-2",
        action: "click",
        intent: "Click the green confirmation button below the requests table.",
        target: {
          role: "button",
          accessibleName: "Confirm selection",
          iconColor: "green",
          relations: [
            {
              relation: "below",
              anchorText: "Requests table",
              tolerancePx: 40,
            },
          ],
        },
        preconditions: [
          {
            type: "element-visible",
            target: "Confirm selection",
            expected: true,
          },
        ],
        postconditions: [
          {
            type: "text-visible",
            target: "Compiled workflow completed",
            expected: "Compiled workflow completed",
          },
        ],
      },
    ],
  });
}

export async function interpretInstructionWithOpenAI(
  instruction: string,
  model: PageModel,
): Promise<{
  result: InterpreterResponse;
  responseModel: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
}> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for live GPT-5.6 compilation.");
  }
  const client = new OpenAI();
  const redactedPageModel = createRedactedCompilerPageModel(model);
  const response = await client.responses.parse({
    model: process.env.OPENAI_COMPILE_MODEL ?? "gpt-5.6",
    store: false,
    reasoning: { effort: "medium" },
    input: [
      {
        role: "system",
        content:
          "Interpret the browser instruction into ordered semantic workflow steps using the supplied page model. Prefer accessibility and spatial relationships over generated IDs or classes. Preserve the requested action order, report material ambiguity, and do not generate Playwright code. Return only the structured result.",
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction,
          pageModel: redactedPageModel,
        }),
      },
    ],
    text: {
      format: interpreterResponseFormat,
    },
  });
  if (!response.output_parsed) {
    throw new Error("GPT-5.6 returned no parsed interpreter result.");
  }
  return {
    result: InterpreterResponseSchema.parse(
      removeNullObjectFields(response.output_parsed),
    ),
    responseModel: response.model,
    tokenUsage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          reasoningTokens:
            response.usage.output_tokens_details.reasoning_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined,
  };
}

export async function interpretInstruction(
  instruction: string,
  model: PageModel,
) {
  if (process.env.USE_LIVE_OPENAI === "true") {
    const live = await interpretInstructionWithOpenAI(instruction, model);
    return {
      ...live,
      source: "gpt-5.6" as const,
      modelCalls: 1,
    };
  }
  return {
    result: mockInterpretInstruction(instruction),
    responseModel: undefined,
    tokenUsage: undefined,
    source: "mock" as const,
    modelCalls: 0,
  };
}
