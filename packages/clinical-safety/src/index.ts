import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalizeTargetUrl } from "@visual-compiler/shared";

export const WorkflowActionSchema = z.enum([
  "click",
  "check",
  "uncheck",
  "fill",
  "select",
  "wait",
  "assert",
]);

export const ApplicationProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  trainingOrigins: z.array(z.string().url()).min(1),
  runtimeOrigins: z.array(z.string().url()).min(1),
  allowedPaths: z.array(z.string().startsWith("/")).min(1),
  profileVersion: z.string().min(1),
  structuralFingerprintVersion: z.string().min(1),
  redactionPolicy: z.literal("strict-no-values"),
  compatibilityThreshold: z.number().min(0).max(1),
  allowedActions: z.array(WorkflowActionSchema),
  requiresSyntheticAttestation: z.boolean(),
  requiresHumanApproval: z.boolean(),
  runtimeOpenAIPolicy: z.literal("forbidden"),
  compilation: z.literal("training profile only"),
  compilationMode: z.literal("training-profile-only"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ApplicationProfile = z.infer<typeof ApplicationProfileSchema>;

const POST_HACKATHON_START = "2026-07-22T00:00:00.000Z";

export const ncbaDpiProfile: ApplicationProfile =
  ApplicationProfileSchema.parse({
    id: "ncba-dpi",
    version: "1.0.0",
    name: "NCBA DPI",
    description:
      "Authorized synthetic training and local deterministic clinical runtime profile.",
    trainingOrigins: ["https://dpi-ncba.gbna-sante.fr"],
    runtimeOrigins: ["https://dpi-ncba.gbna-sante.fr"],
    allowedPaths: ["/"],
    profileVersion: "1",
    structuralFingerprintVersion: "1",
    redactionPolicy: "strict-no-values",
    compatibilityThreshold: 0.85,
    allowedActions: ["click", "check", "uncheck", "select", "wait", "assert"],
    requiresSyntheticAttestation: true,
    requiresHumanApproval: true,
    runtimeOpenAIPolicy: "forbidden",
    compilation: "training profile only",
    compilationMode: "training-profile-only",
    createdAt: POST_HACKATHON_START,
    updatedAt: POST_HACKATHON_START,
  });

export const localFixtureProfile: ApplicationProfile =
  ApplicationProfileSchema.parse({
    ...ncbaDpiProfile,
    id: "ncba-dpi-fixture",
    name: "NCBA DPI synthetic fixture",
    description:
      "Local, non-clinical fixture containing synthetic administrative data only.",
    trainingOrigins: ["http://127.0.0.1:4173"],
    runtimeOrigins: ["http://127.0.0.1:4173"],
    allowedPaths: ["/ncba-fixture"],
  });

export type BrowserMode = "training" | "clinical";

export const browserProfiles = {
  training: {
    id: "ncba-dpi-training",
    mode: "training" as const,
    visible: true,
    manualAuthenticationOnly: true,
    storageDirectoryName: "ncba-dpi-training",
    warning: "SYNTHETIC DATA ONLY — GPT-5.6 COMPILATION ENABLED.",
    compilationAllowed: true,
    persistentScreenshots: false,
  },
  clinical: {
    id: "ncba-dpi-clinical",
    mode: "clinical" as const,
    visible: true,
    manualAuthenticationOnly: true,
    storageDirectoryName: "ncba-dpi-clinical",
    warning: "CLINICAL RUNTIME — OPENAI ACCESS FORBIDDEN.",
    compilationAllowed: false,
    persistentScreenshots: false,
  },
};

export const StudioProfileIdSchema = z.enum([
  "ncba-dpi-fixture",
  "ncba-dpi-training",
  "ncba-dpi-clinical",
]);
export type StudioProfileId = z.infer<typeof StudioProfileIdSchema>;

export const StudioApplicationProfileSchema = z.object({
  id: StudioProfileIdSchema,
  applicationProfileId: z.enum(["ncba-dpi-fixture", "ncba-dpi"]),
  name: z.string(),
  mode: z.enum(["training", "clinical"]),
  defaultUrl: z.string().url(),
  urlEditable: z.boolean(),
  managedBrowserOnly: z.boolean(),
  compilationAllowed: z.boolean(),
  captureAllowed: z.boolean(),
  syntheticAttestationRequired: z.boolean(),
  warning: z.string(),
});
export type StudioApplicationProfile = z.infer<
  typeof StudioApplicationProfileSchema
>;

export function createStudioApplicationProfiles(
  fixtureOrigin = localFixtureProfile.trainingOrigins[0],
): StudioApplicationProfile[] {
  return [
    {
      id: "ncba-dpi-fixture",
      applicationProfileId: "ncba-dpi-fixture",
      name: "NCBA DPI fixture — local synthetic",
      mode: "training",
      defaultUrl: `${fixtureOrigin}/ncba-fixture?mode=training&variant=A`,
      urlEditable: true,
      managedBrowserOnly: false,
      compilationAllowed: true,
      captureAllowed: true,
      syntheticAttestationRequired: true,
      warning: "SYNTHETIC DATA ONLY — LOCAL FIXTURE.",
    },
    {
      id: "ncba-dpi-training",
      applicationProfileId: "ncba-dpi",
      name: "NCBA DPI — authorized synthetic training",
      mode: "training",
      defaultUrl: "https://dpi-ncba.gbna-sante.fr/",
      urlEditable: true,
      managedBrowserOnly: true,
      compilationAllowed: true,
      captureAllowed: true,
      syntheticAttestationRequired: true,
      warning:
        "SYNTHETIC DATA ONLY — MANUAL OPENING — GPT-5.6 COMPILATION GATED.",
    },
    {
      id: "ncba-dpi-clinical",
      applicationProfileId: "ncba-dpi",
      name: "NCBA DPI — clinical runtime",
      mode: "clinical",
      defaultUrl: "https://dpi-ncba.gbna-sante.fr/",
      urlEditable: true,
      managedBrowserOnly: true,
      compilationAllowed: false,
      captureAllowed: false,
      syntheticAttestationRequired: false,
      warning: "CLINICAL RUNTIME — OPENAI ACCESS FORBIDDEN — EXECUTION ONLY.",
    },
  ].map((profile) => StudioApplicationProfileSchema.parse(profile));
}

export function resolveStudioProfileTarget(input: {
  profileId: StudioProfileId;
  targetUrl: string;
  purpose: "open" | "capture" | "compile" | "run";
  fixtureOrigin?: string;
}) {
  const profile = createStudioApplicationProfiles(input.fixtureOrigin).find(
    (candidate) => candidate.id === input.profileId,
  );
  if (!profile) throw new Error("Unknown Studio application profile.");
  if (input.purpose === "compile" && !profile.compilationAllowed) {
    throw new Error("Compilation is technically disabled in clinical mode.");
  }
  if (input.purpose === "capture" && !profile.captureAllowed) {
    throw new Error(
      "Page-model capture is technically disabled in clinical mode.",
    );
  }
  const fixtureOrigin = new URL(input.fixtureOrigin ?? profile.defaultUrl)
    .origin;
  const applicationProfile =
    profile.applicationProfileId === "ncba-dpi-fixture"
      ? ApplicationProfileSchema.parse({
          ...localFixtureProfile,
          trainingOrigins: [fixtureOrigin],
          runtimeOrigins: [fixtureOrigin],
        })
      : ncbaDpiProfile;
  const url = validateTargetUrl(input.targetUrl, {
    mode: profile.mode,
    profile: applicationProfile,
    allowExplicitLocalFixture: profile.id === "ncba-dpi-fixture",
  });
  return { profile, applicationProfile, url };
}

const forbiddenProtocols = new Set([
  "file:",
  "data:",
  "javascript:",
  "blob:",
  "chrome:",
  "chrome-extension:",
]);

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

function isPrivateHost(hostname: string) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    isPrivateIpv4(value) ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  );
}

export type SafeUrlOptions = {
  mode: BrowserMode;
  profile: ApplicationProfile;
  allowExplicitLocalFixture?: boolean;
};

export function validateTargetUrl(raw: string, options: SafeUrlOptions) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Target Website URL is invalid.");
  }
  if (
    forbiddenProtocols.has(url.protocol) ||
    !["https:", "http:"].includes(url.protocol)
  ) {
    throw new Error(`URL protocol ${url.protocol} is forbidden.`);
  }
  if (url.username || url.password)
    throw new Error("Credentials in URLs are forbidden.");
  const localFixture =
    options.allowExplicitLocalFixture === true &&
    options.profile.id === "ncba-dpi-fixture";
  if (url.protocol !== "https:" && !localFixture)
    throw new Error("HTTPS is required.");
  if (isPrivateHost(url.hostname) && !localFixture)
    throw new Error("Private and loopback targets are denied by default.");
  const allowedOrigins =
    options.mode === "training"
      ? options.profile.trainingOrigins
      : options.profile.runtimeOrigins;
  const targetOrigin = new URL(url).origin;
  const configuredOrigins = new Set(
    allowedOrigins.map((allowedOrigin) => new URL(allowedOrigin).origin),
  );
  if (!configuredOrigins.has(targetOrigin))
    throw new Error("Target origin is not allowed by the Application Profile.");
  if (
    !options.profile.allowedPaths.some((prefix) =>
      url.pathname.startsWith(prefix),
    )
  ) {
    throw new Error("Target path is not allowed by the Application Profile.");
  }
  return url;
}

export function validateRedirect(
  from: URL,
  toRaw: string,
  options: SafeUrlOptions,
) {
  const to = validateTargetUrl(new URL(toRaw, from).toString(), options);
  if (new URL(to).origin !== new URL(from).origin)
    throw new Error("Cross-origin redirects are forbidden.");
  return to;
}

export const syntheticAttestationStatements = [
  "authorizedTrainingEnvironment",
  "syntheticDataOnly",
  "noRealPatientDataVisible",
  "noCredentialOrSecretSentToOpenAI",
  "administrativeAndReversible",
] as const;

export const SyntheticAttestationSchema = z.object({
  profileId: z.string(),
  statements: z.object(
    Object.fromEntries(
      syntheticAttestationStatements.map((key) => [key, z.literal(true)]),
    ) as Record<
      (typeof syntheticAttestationStatements)[number],
      z.ZodLiteral<true>
    >,
  ),
  syntheticIndicator: z.enum([
    "training-banner",
    "demo-account",
    "test-tenant",
    "test-record",
    "institution-approved-marker",
  ]),
  indicatorVerifiedLocally: z.literal(true),
  attestedAt: z.string().datetime(),
});

export type SyntheticAttestation = z.infer<typeof SyntheticAttestationSchema>;

export function requireValidAttestation(
  value: unknown,
  profile: ApplicationProfile,
  now = new Date(),
  maxAgeMs = 15 * 60_000,
) {
  const attestation = SyntheticAttestationSchema.parse(value);
  if (attestation.profileId !== profile.id)
    throw new Error("Attestation does not match the Application Profile.");
  const age = now.getTime() - new Date(attestation.attestedAt).getTime();
  if (age < 0 || age > maxAgeMs)
    throw new Error("Synthetic-data attestation has expired.");
  return attestation;
}

export type RawPageNode = {
  tagName: string;
  role?: string;
  label?: string;
  text?: string;
  value?: string;
  selectedValue?: string;
  contentEditableText?: string;
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  required?: boolean;
  box?: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
  children?: RawPageNode[];
  sensitive?: boolean;
};

export type RedactedNode = Omit<
  RawPageNode,
  | "text"
  | "value"
  | "selectedValue"
  | "contentEditableText"
  | "attributes"
  | "children"
  | "sensitive"
> & {
  controlType?: string;
  children?: RedactedNode[];
};

export type RedactedPageModel = {
  origin: string;
  path: string;
  nodes: RedactedNode[];
  report: {
    fieldsRemoved: number;
    valuesRemoved: number;
    sensitiveNodesRemoved: number;
    cookiesCaptured: false;
    storageCaptured: false;
    networkCaptured: false;
  };
};

export function redactPageModel(input: {
  url: string;
  nodes: RawPageNode[];
}): RedactedPageModel {
  const url = new URL(canonicalizeTargetUrl(input.url));
  let fieldsRemoved = 0;
  let valuesRemoved = 0;
  let sensitiveNodesRemoved = 0;
  const clean = (nodes: RawPageNode[]): RedactedNode[] =>
    nodes.flatMap((node) => {
      if (node.sensitive) {
        sensitiveNodesRemoved += 1;
        return [];
      }
      fieldsRemoved += node.attributes
        ? Object.keys(node.attributes).length
        : 0;
      valuesRemoved += [
        node.text,
        node.value,
        node.selectedValue,
        node.contentEditableText,
      ].filter((value) => value !== undefined && value !== "").length;
      const { tagName, role, label, checked, enabled, visible, required, box } =
        node;
      return [
        {
          tagName,
          role,
          label,
          checked,
          enabled,
          visible,
          required,
          box,
          controlType: tagName,
          children: node.children ? clean(node.children) : undefined,
        },
      ];
    });
  return {
    origin: url.origin,
    path: url.pathname,
    nodes: clean(input.nodes),
    report: {
      fieldsRemoved,
      valuesRemoved,
      sensitiveNodesRemoved,
      cookiesCaptured: false,
      storageCaptured: false,
      networkCaptured: false,
    },
  };
}

function canonicalStructure(nodes: RedactedNode[]): unknown[] {
  return nodes.map((node) => ({
    tagName: node.tagName,
    role: node.role,
    label: node.label,
    controlType: node.controlType,
    checked: node.checked,
    enabled: node.enabled,
    visible: node.visible,
    required: node.required,
    relation: node.box
      ? {
          row: Math.round(node.box.y / 24),
          column: Math.round(node.box.x / 24),
        }
      : undefined,
    children: node.children ? canonicalStructure(node.children) : [],
  }));
}

export type StructuralFingerprint = {
  version: "1";
  sha256: string;
  requiredElements: string[];
  features: string[];
};

export function createStructuralFingerprint(
  model: RedactedPageModel,
): StructuralFingerprint {
  const structure = canonicalStructure(model.nodes);
  const features =
    JSON.stringify(structure).match(
      /"(?:role|label|controlType|required)"[^,}\]]*/g,
    ) ?? [];
  const requiredElements = model.nodes.flatMap(function walk(node): string[] {
    const own = node.required
      ? [`${node.role ?? node.tagName}:${node.label ?? "unlabelled"}`]
      : [];
    return own.concat((node.children ?? []).flatMap(walk));
  });
  return {
    version: "1",
    sha256: createHash("sha256")
      .update(JSON.stringify(structure))
      .digest("hex"),
    requiredElements,
    features: [...new Set(features)].sort(),
  };
}

export function compareStructuralFingerprints(
  expected: StructuralFingerprint,
  actual: StructuralFingerprint,
) {
  const expectedSet = new Set(expected.features);
  const actualSet = new Set(actual.features);
  const intersection = [...expectedSet].filter((feature) =>
    actualSet.has(feature),
  ).length;
  const union = new Set([...expectedSet, ...actualSet]).size || 1;
  const missingRequired = expected.requiredElements.filter(
    (item) => !actual.requiredElements.includes(item),
  );
  return {
    score: intersection / union,
    compatible: missingRequired.length === 0 && intersection / union >= 0.85,
    missingRequired,
    differencesRedacted: [...expectedSet].filter(
      (feature) => !actualSet.has(feature),
    ),
  };
}

export const WorkflowStateSchema = z.enum([
  "Draft",
  "Validated",
  "Approved",
  "Promoted",
  "Revoked",
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
const transitions: Record<WorkflowState, WorkflowState[]> = {
  Draft: ["Validated"],
  Validated: ["Approved"],
  Approved: ["Promoted"],
  Promoted: ["Revoked"],
  Revoked: [],
};

export function transitionWorkflow(
  current: WorkflowState,
  next: WorkflowState,
  checksPassed = true,
) {
  if (!transitions[current].includes(next))
    throw new Error(`Invalid workflow transition: ${current} -> ${next}.`);
  if ((next === "Validated" || next === "Promoted") && !checksPassed)
    throw new Error("Workflow checks must pass before this transition.");
  return next;
}

export type PromotedWorkflow = {
  workflowId: string;
  workflowVersion: string;
  applicationProfileId: string;
  state: WorkflowState;
  allowedRuntimeOrigins: string[];
  allowedPaths: string[];
  structuralFingerprint: StructuralFingerprint;
  fingerprintVersion: string;
  compileModel: string;
  promptVersion: string;
  compiledFromSyntheticData: true;
  syntheticAttestationTimestamp: string;
  selectedLocators: string[];
  fallbackLocators: string[];
  preconditions: string[];
  postconditions: string[];
  confidence: number;
  approvalTimestamp: string;
  promotionTimestamp: string;
  runtimeOpenAIPolicy: "forbidden";
  workflowSha256: string;
};

export function computeWorkflowHash(
  workflow: Omit<PromotedWorkflow, "workflowSha256">,
) {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

export function verifyWorkflowHash(workflow: PromotedWorkflow) {
  const { workflowSha256, ...unsigned } = workflow;
  return workflowSha256 === computeWorkflowHash(unsigned);
}

export function clinicalPreflight(input: {
  workflow: PromotedWorkflow;
  profile: ApplicationProfile;
  url: string;
  actualFingerprint: StructuralFingerprint;
  targetsUnique: boolean;
  preconditionsPassed: boolean;
  humanConfirmed: boolean;
}) {
  const failures: string[] = [];
  if (input.workflow.applicationProfileId !== input.profile.id)
    failures.push("application-profile");
  let target: URL | undefined;
  try {
    target = validateTargetUrl(input.url, {
      mode: "clinical",
      profile: input.profile,
      allowExplicitLocalFixture: input.profile.id === "ncba-dpi-fixture",
    });
  } catch {
    failures.push("origin-or-path");
  }
  if (
    target &&
    (!input.workflow.allowedRuntimeOrigins.includes(target.origin) ||
      !input.workflow.allowedPaths.some((prefix) =>
        target!.pathname.startsWith(prefix),
      ))
  ) {
    failures.push("artifact-origin-or-path");
  }
  if (input.workflow.state !== "Promoted") failures.push("not-promoted");
  if (!verifyWorkflowHash(input.workflow)) failures.push("invalid-hash");
  if (
    input.workflow.runtimeOpenAIPolicy !== "forbidden" ||
    input.profile.runtimeOpenAIPolicy !== "forbidden"
  )
    failures.push("openai-policy");
  const compatibility = compareStructuralFingerprints(
    input.workflow.structuralFingerprint,
    input.actualFingerprint,
  );
  if (
    compatibility.score < input.profile.compatibilityThreshold ||
    compatibility.missingRequired.length > 0
  )
    failures.push("structural-compatibility");
  if (!input.targetsUnique) failures.push("ambiguous-target");
  if (!input.preconditionsPassed) failures.push("precondition");
  if (!input.humanConfirmed) failures.push("human-confirmation");
  return {
    allowed: failures.length === 0,
    failures,
    origin: target?.origin,
    structuralCompatibility: compatibility.score,
    differencesRedacted: compatibility.differencesRedacted,
  };
}

export type RuntimeParameters = Record<string, string>;
export async function withRuntimeParameters<T>(
  parameters: RuntimeParameters,
  operation: (parameters: RuntimeParameters) => Promise<T>,
) {
  const memory = { ...parameters };
  try {
    return await operation(memory);
  } finally {
    for (const key of Object.keys(memory)) delete memory[key];
    for (const key of Object.keys(parameters)) delete parameters[key];
  }
}

export function createRedactedAudit(input: {
  workflow: PromotedWorkflow;
  origin: string;
  structuralCompatibility: number;
  startTime: string;
  endTime: string;
  stepIds: string[];
  actionTypes: string[];
  stepResults: string[];
  errors?: unknown[];
}) {
  const canonicalTargetUrl = canonicalizeTargetUrl(input.origin);
  return {
    workflowId: input.workflow.workflowId,
    workflowVersion: input.workflow.workflowVersion,
    workflowHash: input.workflow.workflowSha256,
    applicationProfileId: input.workflow.applicationProfileId,
    origin: new URL(canonicalTargetUrl).origin,
    targetUrl: canonicalTargetUrl,
    structuralCompatibility: input.structuralCompatibility,
    startTime: input.startTime,
    endTime: input.endTime,
    duration: Math.max(
      0,
      new Date(input.endTime).getTime() - new Date(input.startTime).getTime(),
    ),
    stepIds: input.stepIds,
    actionTypes: input.actionTypes,
    stepResults: input.stepResults,
    errorsRedacted: (input.errors ?? []).map(
      () => "Runtime step failed (details redacted).",
    ),
    llmCalls: 0 as const,
    openAIRequests: 0 as const,
  };
}

export async function appendRedactedAudit(
  auditPath: string,
  entry: ReturnType<typeof createRedactedAudit>,
) {
  const directory = dirname(auditPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(auditPath, 0o600);
}

export const CompatibilityProbeReportSchema = z.object({
  standardDomElements: z.number().int().nonnegative(),
  accessibleControls: z.number().int().nonnegative(),
  iframesDetected: z.number().int().nonnegative(),
  shadowRootsDetected: z.number().int().nonnegative(),
  canvasElementsDetected: z.number().int().nonnegative(),
  spaNavigationDetected: z.boolean(),
  stableLabelsDetected: z.number().int().nonnegative(),
  compatibilityLevel: z.enum(["high", "medium", "low"]),
  limitations: z.array(z.string()),
});

export const compatibilityProbe = {
  enabledByDefault: false,
  realTargetExecuted: false,
  requiresVisibleBrowser: true,
  requiresExplicitAuthorizationConfirmation: true,
  capturesScreenshots: false,
  readsCookies: false,
  inspectsNetwork: false,
  callsLlm: false,
} as const;
