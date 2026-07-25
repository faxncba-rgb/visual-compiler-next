import path from "node:path";

const legacyDemoUrl = process.env.DEMO_SITE_URL;

export const DEFAULT_DEMO_INTERNAL_URL =
  process.env.DEMO_SITE_INTERNAL_URL ??
  legacyDemoUrl ??
  "http://127.0.0.1:4173";
export const DEFAULT_DEMO_PUBLIC_URL =
  process.env.DEMO_SITE_PUBLIC_URL ?? legacyDemoUrl ?? "http://127.0.0.1:4173";

// Kept for local scripts and third-party imports written before the URL split.
export const DEFAULT_DEMO_URL = DEFAULT_DEMO_INTERNAL_URL;
export const DEFAULT_INSTRUCTION =
  "In the row containing 'Pending review', check the first enabled checkbox to the right of the status text, then click the green confirmation button below the table.";

export const WORKFLOW_STORAGE_DIR = path.resolve(
  process.env.WORKFLOW_STORAGE_DIR ?? "compiled-workflows",
);
export const WORKFLOW_PATH = path.join(
  WORKFLOW_STORAGE_DIR,
  "pending-review.workflow.json",
);

export const nowIso = () => new Date().toISOString();

export function canonicalizeTargetUrl(target: string | URL) {
  const url = target instanceof URL ? target : new URL(target);
  return `${url.origin}${url.pathname}`;
}
