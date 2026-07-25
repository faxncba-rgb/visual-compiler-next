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

export const CompilerTextClassificationSchema = z.enum([
  "interface-label",
  "control-name",
  "structural-heading",
  "redacted-value",
  "excluded-content",
]);
export type CompilerTextClassification = z.infer<
  typeof CompilerTextClassificationSchema
>;

function normalizedInterfaceText(value: string | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!normalized) return undefined;
  if (
    /(?:https?:\/\/|bearer\s+|token\s*[=:]|session\s*[=:]|cookie\s*[=:])/i.test(
      normalized,
    ) ||
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(normalized) ||
    /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(normalized) ||
    /\b\d{8,}\b/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function createRedactedCompilerPageModel(model: PageModel) {
  const url = new URL(canonicalizeTargetUrl(model.url));
  const interactiveRoles = new Set([
    "button",
    "checkbox",
    "textbox",
    "searchbox",
    "combobox",
    "option",
    "link",
    "radio",
    "switch",
    "tab",
    "menuitem",
  ]);
  const structuralTags = new Set([
    "form",
    "section",
    "fieldset",
    "legend",
    "label",
    "main",
    "article",
    "dialog",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "caption",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
  ]);
  const included = model.nodes.filter(
    (node) =>
      node.visible &&
      node.attributes.type !== "hidden" &&
      (interactiveRoles.has(node.role ?? "") ||
        structuralTags.has(node.tagName)),
  );
  const includedIds = new Set(included.map((node) => node.id));
  const rawById = new Map(model.nodes.map((node) => [node.id, node]));
  const structuralIndexById = new Map(
    included.map((node, structuralIndex) => [node.id, structuralIndex]),
  );
  const nearestIncludedAncestor = (parentId: string | undefined) => {
    let currentId = parentId;
    while (currentId) {
      if (includedIds.has(currentId)) return structuralIndexById.get(currentId);
      currentId = rawById.get(currentId)?.parentId;
    }
    return undefined;
  };
  const textEntry = (
    classification: CompilerTextClassification,
    source: string,
    rawValue: string | undefined,
  ) => {
    const text = normalizedInterfaceText(rawValue);
    return text
      ? { classification, source, text }
      : rawValue
        ? {
            classification: "redacted-value" as const,
            source,
            text: "[REDACTED]",
          }
        : undefined;
  };
  let accessibleNamesKept = 0;
  let labelsKept = 0;
  let valuesRemoved = 0;
  let sensitiveTextsRemoved = 0;
  const nodes = included.map((node, structuralIndex) => {
    const accessibleName = normalizedInterfaceText(node.accessibleName);
    const labelText = normalizedInterfaceText(node.labelText);
    const ariaLabel = normalizedInterfaceText(node.ariaLabel);
    const ariaLabelledByText = normalizedInterfaceText(node.ariaLabelledByText);
    const placeholder = normalizedInterfaceText(node.placeholder);
    const controlText = normalizedInterfaceText(node.controlText);
    const structuralHeading = normalizedInterfaceText(node.structuralHeading);
    accessibleNamesKept += Number(Boolean(accessibleName));
    labelsKept += Number(Boolean(labelText || ariaLabel || ariaLabelledByText));
    const rawSemanticTexts = [
      ["control-name", "accessible-name", node.accessibleName],
      ["interface-label", "associated-label", node.labelText],
      ["interface-label", "aria-label", node.ariaLabel],
      ["interface-label", "aria-labelledby", node.ariaLabelledByText],
      ["interface-label", "placeholder", node.placeholder],
      ["control-name", "control-text", node.controlText],
      ["structural-heading", "nearest-heading", node.structuralHeading],
    ] as const;
    const texts = rawSemanticTexts
      .map(([classification, source, value]) => {
        const entry = textEntry(classification, source, value);
        if (entry?.classification === "redacted-value")
          sensitiveTextsRemoved += 1;
        return entry;
      })
      .filter((entry) => entry !== undefined)
      .filter(
        (entry, index, entries) =>
          entries.findIndex(
            (candidate) =>
              candidate.classification === entry.classification &&
              candidate.text === entry.text,
          ) === index,
      );
    const children = included
      .filter((candidate) => candidate.parentId === node.id)
      .map((candidate) => structuralIndexById.get(candidate.id))
      .filter((index) => index !== undefined);
    return {
      structuralIndex,
      tagName: node.tagName,
      role: node.role,
      controlType: node.controlType ?? node.attributes.type ?? node.tagName,
      stableLabel: normalizedInterfaceText(
        node.attributes["data-vc-stable-label"],
      ),
      accessibleName,
      labelText,
      ariaLabel,
      ariaLabelledByText,
      placeholder,
      controlText,
      structuralHeading,
      texts,
      box: node.box,
      visible: node.visible,
      enabled: node.enabled,
      checked: node.checked,
      parentIndex: nearestIncludedAncestor(node.parentId),
      childIndices: children,
      previousSiblingIndex: structuralIndexById.get(
        node.previousSiblingId ?? "",
      ),
      nextSiblingIndex: structuralIndexById.get(node.nextSiblingId ?? ""),
      domOrder: node.domOrder ?? structuralIndex,
      visualOrder: node.visualOrder ?? structuralIndex,
    };
  });
  const fieldsRemoved = model.nodes.reduce(
    (count, node) =>
      count +
      Object.keys(node.attributes).filter(
        (name) =>
          ![
            "type",
            "aria-label",
            "aria-labelledby",
            "placeholder",
            "required",
            "data-vc-stable-label",
          ].includes(name),
      ).length,
    0,
  );
  valuesRemoved += model.nodes.reduce(
    (count, node) =>
      count +
      Number(node.valueWasPresent === true) +
      Number(Boolean(node.attributes.value)) +
      Number(Boolean(node.attributes.selected)) +
      Number(Boolean(node.attributes["data-value"])),
    0,
  );
  return {
    origin: url.origin,
    path: url.pathname,
    viewport: model.viewport,
    textPolicy: {
      classifications: CompilerTextClassificationSchema.options,
      arbitraryContentIncluded: false,
      formValuesIncluded: false,
    },
    redactionMarkers: [
      {
        classification: "redacted-value" as const,
        count: valuesRemoved,
        text: "[REDACTED]",
      },
      {
        classification: "excluded-content" as const,
        count: model.nodes.length - included.length,
        text: "[EXCLUDED]",
      },
    ],
    nodes,
    redactionReport: {
      nodesCaptured: model.nodes.length,
      nodesIncluded: nodes.length,
      interactiveElements: nodes.filter((node) =>
        interactiveRoles.has(node.role ?? ""),
      ).length,
      accessibleNamesKept,
      labelsKept,
      fieldsRemoved,
      valuesRemoved,
      sensitiveTextsRemoved,
      sensitiveNodesRemoved: model.nodes.length - included.length,
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

export const CGI_FIXTURE_INSTRUCTION =
  "Dans la zone de texte, écris « test du DR LEROY », puis clique sur « Enregistrer ».";

export function mockInterpretInstruction(
  instruction = DEFAULT_INSTRUCTION,
): InterpreterResponse {
  const normalizedInstruction = normalizeInstruction(instruction);
  if (normalizedInstruction === normalizeInstruction(CGI_FIXTURE_INSTRUCTION)) {
    return InterpreterResponseSchema.parse({
      name: "Synthetic CGI administrative note",
      assumptions: [
        "The textarea identified by its associated interface label is the intended reversible administrative field.",
      ],
      ambiguityWarnings: [
        "Several Save buttons exist; the nearest shared form section disambiguates the target deterministically.",
      ],
      confidence: 0.94,
      expectedResult:
        "The synthetic administrative textarea contains the requested test text and its section reports a saved state.",
      steps: [
        {
          id: "fill-administrative-observation",
          action: "fill",
          intent: "Fill the multiline field labelled Observation du praticien.",
          target: {
            role: "textbox",
            accessibleName: "Observation du praticien",
            state: "enabled",
            relations: [
              {
                relation: "nearest",
                anchorText: "Observation du praticien",
                tolerancePx: 40,
              },
            ],
          },
          value: "test du DR LEROY",
          preconditions: [
            {
              type: "element-visible",
              target: "Observation du praticien",
              expected: true,
            },
            {
              type: "element-enabled",
              target: "Observation du praticien",
              expected: true,
            },
          ],
          postconditions: [
            {
              type: "element-visible",
              target: "Observation du praticien",
              expected: true,
            },
          ],
        },
        {
          id: "save-administrative-observation",
          action: "click",
          intent:
            "Click the Save button in the same administrative section as the textarea.",
          target: {
            role: "button",
            accessibleName: "Enregistrer",
            state: "enabled",
            relations: [
              {
                relation: "nearest",
                anchorText: "Observation du praticien",
                tolerancePx: 60,
              },
            ],
          },
          preconditions: [
            {
              type: "element-visible",
              target: "Enregistrer",
              expected: true,
            },
            {
              type: "element-enabled",
              target: "Enregistrer",
              expected: true,
            },
          ],
          postconditions: [
            {
              type: "text-visible",
              target: "Enregistrement synthétique effectué",
              expected: "Enregistrement synthétique effectué",
            },
          ],
        },
      ],
    });
  }
  if (normalizedInstruction !== normalizeInstruction(DEFAULT_INSTRUCTION)) {
    throw new Error(
      "The offline mock interpreter supports only the documented Pending review and synthetic CGI fixtures. Enable live compilation only after a separate explicit authorization.",
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
  const configuredTimeout = Number.parseInt(
    process.env.OPENAI_COMPILE_TIMEOUT_MS ?? "120000",
    10,
  );
  const timeout =
    Number.isFinite(configuredTimeout) &&
    configuredTimeout >= 1_000 &&
    configuredTimeout <= 600_000
      ? configuredTimeout
      : 120_000;
  const client = new OpenAI({ timeout, maxRetries: 0 });
  const redactedPageModel = createRedactedCompilerPageModel(model);
  const response = await client.responses.parse({
    model: process.env.OPENAI_COMPILE_MODEL ?? "gpt-5.6",
    store: false,
    reasoning: { effort: "medium" },
    input: [
      {
        role: "system",
        content:
          "Interpret the browser instruction into ordered semantic workflow steps using only the supplied redacted semantic page model. Prefer role plus accessible name, associated labels, placeholders, control text, DOM relations, then spatial relations. Never infer or reproduce excluded values. Preserve the requested action order, report material ambiguity, and do not generate Playwright code. Return only the structured result.",
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
