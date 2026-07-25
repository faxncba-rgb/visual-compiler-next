import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compileWorkflow,
  createRedactedCompilerPageModel,
  mockInterpretInstruction,
} from "@visual-compiler/compiler";
import type { PageModel } from "@visual-compiler/page-model";
import { DEFAULT_INSTRUCTION } from "@visual-compiler/shared";

describe("compiler privacy boundary", () => {
  it("passes only structural fields and explicitly stable labels to the model boundary", () => {
    const model: PageModel = {
      url: "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi?patient_id=PRIVATE&mytime=PRIVATE-TIME",
      viewport: { width: 800, height: 600 },
      capturedAt: new Date().toISOString(),
      nodes: [
        {
          id: "generated-private-id",
          tagName: "input",
          role: "textbox",
          accessibleName: "PRIVATE PERSON",
          text: "PRIVATE BUSINESS VALUE",
          box: { x: 10, y: 10, width: 100, height: 30 },
          visible: true,
          enabled: true,
          attributes: {
            value: "PRIVATE INPUT",
            "data-vc-stable-label": "administrative-search",
          },
        },
      ],
    };
    const redacted = createRedactedCompilerPageModel(model);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain("generated-private-id");
    expect(serialized).not.toContain("patient=");
    expect(serialized).not.toContain("patient_id");
    expect(serialized).not.toContain("mytime");
    expect(redacted).toMatchObject({
      origin: "https://dpi-ncba.gbna-sante.fr",
      path: "/saisie/consultations.cgi",
    });
    expect(serialized).toContain("administrative-search");
    expect(redacted.redactionReport).toMatchObject({
      cookiesCaptured: false,
      storageCaptured: false,
      networkCaptured: false,
    });
  });

  it("compiles from an already-open managed page model without navigating", async () => {
    const model: PageModel = {
      url: "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi?patient_id=FAKE-A&mytime=111",
      viewport: { width: 800, height: 600 },
      capturedAt: new Date().toISOString(),
      nodes: [
        {
          id: "table",
          tagName: "table",
          role: "table",
          accessibleName: "Requests table",
          text: "Requests table",
          box: { x: 20, y: 20, width: 600, height: 300 },
          visible: true,
          enabled: true,
          attributes: {},
        },
        {
          id: "status",
          tagName: "span",
          accessibleName: "Pending review",
          text: "Pending review",
          box: { x: 80, y: 100, width: 110, height: 20 },
          visible: true,
          enabled: true,
          attributes: {},
        },
        {
          id: "checkbox",
          tagName: "input",
          role: "checkbox",
          accessibleName: "Synthetic selection",
          text: "",
          box: { x: 230, y: 100, width: 20, height: 20 },
          visible: true,
          enabled: true,
          attributes: { type: "checkbox" },
        },
        {
          id: "confirm",
          tagName: "button",
          role: "button",
          accessibleName: "Confirm selection",
          text: "Confirm selection",
          box: { x: 450, y: 360, width: 130, height: 40 },
          visible: true,
          enabled: true,
          color: "green",
          attributes: { "aria-label": "Confirm selection" },
        },
      ],
    };
    const directory = await mkdtemp(path.join(tmpdir(), "vc-canonical-"));
    try {
      const workflow = await compileWorkflow({
        instruction: DEFAULT_INSTRUCTION,
        url: "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi?patient_id=FAKE-A&mytime=111",
        pageModel: model,
        outDir: directory,
        interpreter: async (instruction, compilerModel) => {
          expect(compilerModel.url).toBe(
            "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi",
          );
          expect(compilerModel.url).not.toContain("patient_id");
          expect(compilerModel.url).not.toContain("mytime");
          return {
            result: mockInterpretInstruction(instruction),
            responseModel: undefined,
            tokenUsage: undefined,
            source: "mock" as const,
            modelCalls: 0,
          };
        },
      });
      const serializedWorkflow = JSON.stringify(workflow);
      const storedArtifact = await readFile(
        path.join(directory, `${workflow.id}.json`),
        "utf8",
      );
      expect(workflow.source.url).toBe(
        "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi",
      );
      expect(workflow.metadata.targetUrl).toBe(
        "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi",
      );
      for (const serialized of [serializedWorkflow, storedArtifact]) {
        expect(serialized).not.toContain("patient_id");
        expect(serialized).not.toContain("mytime");
        expect(serialized).not.toContain("FAKE-A");
      }
      expect(workflow.diagnostics).toMatchObject({
        interpretationSource: "mock",
        modelCalls: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
