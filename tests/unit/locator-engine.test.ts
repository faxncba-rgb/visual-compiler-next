import { describe, expect, it } from "vitest";
import {
  explainZeroCandidates,
  generateCandidates,
  selectBestCandidate,
} from "@visual-compiler/locator-engine";
import type { PageModel } from "@visual-compiler/page-model";
import type { SemanticStep } from "@visual-compiler/semantic-ir";

const model: PageModel = {
  url: "http://local",
  viewport: { width: 800, height: 600 },
  capturedAt: new Date().toISOString(),
  nodes: [
    {
      id: "unrelated-text",
      tagName: "label",
      text: "Pending review",
      accessibleName: "Pending review",
      visible: true,
      enabled: true,
      box: { x: 500, y: 20, width: 200, height: 20 },
      attributes: {},
    },
    {
      id: "text",
      tagName: "span",
      text: "Pending review",
      accessibleName: "Pending review",
      visible: true,
      enabled: true,
      box: { x: 100, y: 100, width: 100, height: 20 },
      attributes: {},
    },
    {
      id: "disabled",
      tagName: "input",
      role: "checkbox",
      text: "",
      accessibleName: "disabled",
      visible: true,
      enabled: false,
      box: { x: 230, y: 100, width: 20, height: 20 },
      attributes: {},
    },
    {
      id: "enabled",
      tagName: "input",
      role: "checkbox",
      text: "",
      accessibleName: "enabled",
      visible: true,
      enabled: true,
      box: { x: 270, y: 100, width: 20, height: 20 },
      attributes: {},
    },
    {
      id: "second",
      tagName: "input",
      role: "checkbox",
      text: "",
      accessibleName: "second",
      visible: true,
      enabled: true,
      box: { x: 310, y: 100, width: 20, height: 20 },
      attributes: {},
    },
  ],
};

const step: SemanticStep = {
  id: "s1",
  action: "check",
  intent: "Check first enabled checkbox",
  target: {
    role: "checkbox",
    state: "enabled",
    ordinal: 1,
    relations: [
      { relation: "right-of", anchorText: "Pending review", tolerancePx: 24 },
    ],
  },
  preconditions: [],
  postconditions: [],
  candidates: [],
};

describe("locator engine", () => {
  it("skips unrelated duplicate anchors and selects the first enabled right-of target", () => {
    const candidates = generateCandidates(model, step);
    expect(
      new Set(candidates.map((candidate) => candidate.node?.id)),
    ).toEqual(new Set(["enabled", "second"]));
    expect(selectBestCandidate(candidates).node?.id).toBe("enabled");
    expect(selectBestCandidate(candidates).selector).toContain("nth=1");
  });

  it("rejects ambiguous non-unique low quality targets", () => {
    expect(() =>
      selectBestCandidate([
        {
          strategy: "role-name",
          selector: "role=checkbox",
          confidence: 0.4,
          unique: false,
          stability: 0.4,
          explanation: "ambiguous",
          fallbackOrder: 0,
        },
      ]),
    ).toThrow();
  });

  it("explains zero candidates using redacted counts only", () => {
    const missingStep: SemanticStep = {
      ...step,
      id: "missing-textarea",
      action: "fill",
      target: {
        role: "textbox",
        accessibleName: "Missing interface label",
        relations: [],
      },
    };
    expect(generateCandidates(model, missingStep)).toEqual([]);
    const reason = explainZeroCandidates(model, missingStep);
    expect(reason).toContain("Visible role matches: 0");
    expect(reason).toContain("Semantic-name matches: 0");
    expect(reason).not.toContain("Pending review");
    expect(reason).not.toContain("disabled");
  });

  it("selects a labelled textarea and the Save button in its nearest DOM section without test attributes", () => {
    const cgiModel: PageModel = {
      url: "http://127.0.0.1/cgi-professional",
      viewport: { width: 900, height: 700 },
      capturedAt: new Date().toISOString(),
      nodes: [
        {
          id: "main",
          tagName: "main",
          text: "",
          visible: true,
          enabled: true,
          box: { x: 20, y: 20, width: 860, height: 660 },
          attributes: {},
          domOrder: 0,
          visualOrder: 0,
        },
        {
          id: "section-a",
          tagName: "section",
          text: "",
          visible: true,
          enabled: true,
          box: { x: 40, y: 80, width: 820, height: 250 },
          attributes: {},
          parentId: "main",
          domOrder: 1,
          visualOrder: 1,
        },
        {
          id: "label-a",
          tagName: "label",
          accessibleName: "Observation du praticien",
          text: "Observation du praticien",
          visible: true,
          enabled: true,
          box: { x: 60, y: 120, width: 240, height: 24 },
          attributes: {},
          parentId: "section-a",
          domOrder: 2,
          visualOrder: 2,
        },
        {
          id: "textarea-a",
          tagName: "textarea",
          role: "textbox",
          controlType: "textarea",
          accessibleName: "Observation du praticien",
          labelText: "Observation du praticien",
          text: "",
          visible: true,
          enabled: true,
          box: { x: 60, y: 154, width: 600, height: 100 },
          attributes: {},
          parentId: "section-a",
          domOrder: 3,
          visualOrder: 3,
        },
        {
          id: "save-a",
          tagName: "button",
          role: "button",
          controlType: "button",
          accessibleName: "Enregistrer",
          controlText: "Enregistrer",
          text: "Enregistrer",
          visible: true,
          enabled: true,
          box: { x: 60, y: 270, width: 130, height: 40 },
          attributes: {},
          parentId: "section-a",
          domOrder: 4,
          visualOrder: 4,
        },
        {
          id: "section-b",
          tagName: "section",
          text: "",
          visible: true,
          enabled: true,
          box: { x: 40, y: 360, width: 820, height: 250 },
          attributes: {},
          parentId: "main",
          domOrder: 5,
          visualOrder: 5,
        },
        {
          id: "save-b",
          tagName: "button",
          role: "button",
          controlType: "button",
          accessibleName: "Enregistrer",
          controlText: "Enregistrer",
          text: "Enregistrer",
          visible: true,
          enabled: true,
          box: { x: 60, y: 540, width: 130, height: 40 },
          attributes: {},
          parentId: "section-b",
          domOrder: 6,
          visualOrder: 6,
        },
      ],
    };
    const fillStep: SemanticStep = {
      id: "fill",
      action: "fill",
      intent: "Fill the intended textarea",
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
      value: "synthetic",
      preconditions: [],
      postconditions: [],
      candidates: [],
    };
    const saveStep: SemanticStep = {
      id: "save",
      action: "click",
      intent: "Save the intended section",
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
      preconditions: [],
      postconditions: [],
      candidates: [],
    };
    const fillCandidates = generateCandidates(cgiModel, fillStep);
    const saveCandidates = generateCandidates(cgiModel, saveStep);
    expect(selectBestCandidate(fillCandidates).node?.id).toBe("textarea-a");
    expect(selectBestCandidate(saveCandidates).node?.id).toBe("save-a");
    expect(selectBestCandidate(saveCandidates).strategy).toBe(
      "text-dom-relation",
    );
    expect(
      generateCandidates(cgiModel, saveStep).map(
        (candidate) => `${candidate.strategy}:${candidate.selector}`,
      ),
    ).toEqual(
      saveCandidates.map(
        (candidate) => `${candidate.strategy}:${candidate.selector}`,
      ),
    );
  });
});
