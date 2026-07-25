import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CGI_FIXTURE_INSTRUCTION,
  compileWorkflow,
  createRedactedCompilerPageModel,
  mockInterpretInstruction,
} from "@visual-compiler/compiler";
import type { PageModel } from "@visual-compiler/page-model";
import { DEFAULT_INSTRUCTION } from "@visual-compiler/shared";

describe("compiler privacy boundary", () => {
  it("keeps classified interface semantics while removing form values and URL parameters", () => {
    const model: PageModel = {
      url: "https://dpi-ncba.gbna-sante.fr/saisie/consultations.cgi?patient_id=PRIVATE&mytime=PRIVATE-TIME",
      viewport: { width: 800, height: 600 },
      capturedAt: new Date().toISOString(),
      nodes: [
        {
          id: "generated-private-id",
          tagName: "input",
          role: "textbox",
          controlType: "text",
          accessibleName: "Recherche administrative",
          labelText: "Recherche administrative",
          ariaLabel: "Recherche administrative",
          placeholder: "Rechercher un dossier de test",
          text: "",
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
    expect(serialized).toContain("Recherche administrative");
    expect(serialized).toContain('"classification":"control-name"');
    expect(serialized).toContain('"classification":"interface-label"');
    expect(redacted.redactionReport).toMatchObject({
      interactiveElements: 1,
      accessibleNamesKept: 1,
      labelsKept: 1,
      valuesRemoved: 1,
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

  it("compiles labelled CGI controls without stable test attributes and never persists removed values", async () => {
    const model: PageModel = {
      url: "http://127.0.0.1:4273/cgi-professional?patient_id=FAKE-CGI&mytime=999",
      viewport: { width: 900, height: 700 },
      capturedAt: new Date().toISOString(),
      nodes: [
        {
          id: "section-a",
          tagName: "section",
          text: "",
          box: { x: 20, y: 40, width: 800, height: 260 },
          visible: true,
          enabled: true,
          attributes: {},
        },
        {
          id: "label-a",
          tagName: "label",
          accessibleName: "Observation du praticien",
          text: "Observation du praticien",
          box: { x: 40, y: 90, width: 220, height: 24 },
          visible: true,
          enabled: true,
          attributes: {},
          parentId: "section-a",
        },
        {
          id: "textarea-a",
          tagName: "textarea",
          role: "textbox",
          controlType: "textarea",
          accessibleName: "Observation du praticien",
          labelText: "Observation du praticien",
          text: "",
          box: { x: 40, y: 125, width: 600, height: 100 },
          visible: true,
          enabled: true,
          attributes: { value: "REMOVED-SYNTHETIC-FIELD-VALUE" },
          parentId: "section-a",
        },
        {
          id: "save-a",
          tagName: "button",
          role: "button",
          controlType: "button",
          accessibleName: "Enregistrer",
          controlText: "Enregistrer",
          text: "Enregistrer",
          box: { x: 40, y: 240, width: 130, height: 40 },
          visible: true,
          enabled: true,
          attributes: {},
          parentId: "section-a",
        },
        {
          id: "section-b",
          tagName: "section",
          text: "",
          box: { x: 20, y: 330, width: 800, height: 260 },
          visible: true,
          enabled: true,
          attributes: {},
        },
        {
          id: "save-b",
          tagName: "button",
          role: "button",
          controlType: "button",
          accessibleName: "Enregistrer",
          controlText: "Enregistrer",
          text: "Enregistrer",
          box: { x: 40, y: 520, width: 130, height: 40 },
          visible: true,
          enabled: true,
          attributes: {},
          parentId: "section-b",
        },
      ],
    };
    const directory = await mkdtemp(path.join(tmpdir(), "vc-cgi-"));
    try {
      const progress: string[] = [];
      const workflow = await compileWorkflow({
        instruction: CGI_FIXTURE_INSTRUCTION,
        url: model.url,
        pageModel: model,
        outDir: directory,
        interpreter: async (instruction) => ({
          result: mockInterpretInstruction(instruction),
          responseModel: undefined,
          tokenUsage: undefined,
          source: "mock" as const,
          modelCalls: 0,
        }),
        onProgress: (stage) => {
          progress.push(stage);
        },
      });
      expect(progress).toEqual([
        "Preparing redacted payload",
        "Calling GPT-5.6",
        "Validating Semantic IR",
        "Generating locators",
        "Saving artifact",
        "Compilation complete",
      ]);
      expect(workflow.steps.map((step) => step.action)).toEqual([
        "fill",
        "click",
      ]);
      expect(workflow.steps.every((step) => step.candidates.length > 0)).toBe(
        true,
      );
      expect(workflow.steps[0].selectedLocator?.rule?.candidateText).toBe(
        "Observation du praticien",
      );
      expect(workflow.steps[1].selectedLocator?.primary).toContain("near-dom");
      expect(workflow.diagnostics.locatorDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "fill-administrative-observation",
            candidateCount: expect.any(Number),
          }),
          expect.objectContaining({
            stepId: "save-administrative-observation",
            candidateCount: expect.any(Number),
          }),
        ]),
      );
      const artifact = await readFile(
        path.join(directory, `${workflow.id}.json`),
        "utf8",
      );
      expect(artifact).not.toContain("REMOVED-SYNTHETIC-FIELD-VALUE");
      expect(artifact).not.toContain("patient_id");
      expect(artifact).not.toContain("mytime");
      expect(artifact).not.toContain("FAKE-CGI");
      expect(workflow.diagnostics.modelCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
