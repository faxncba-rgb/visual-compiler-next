import { describe, expect, it } from "vitest";
import {
  createStructuralFingerprint,
  compareStructuralFingerprints,
  redactPageModel,
} from "@visual-compiler/clinical-safety";

const raw = (businessValue: string, x = 24) => ({
  url: `https://dpi-ncba.gbna-sante.fr/queue?record=${encodeURIComponent(businessValue)}`,
  nodes: [
    {
      tagName: "form",
      role: "form",
      label: "Administrative queue",
      box: { x: 0, y: 0, width: 400, height: 300 },
      children: [
        {
          tagName: "input",
          role: "textbox",
          label: "Search",
          value: businessValue,
          text: businessValue,
          attributes: { autocomplete: "off", token: "secret" },
          required: true,
          enabled: true,
          visible: true,
          box: { x, y: 24, width: 200, height: 40 },
        },
        {
          tagName: "textarea",
          role: "textbox",
          label: "Notes",
          value: businessValue,
          contentEditableText: businessValue,
          visible: true,
          box: { x, y: 80, width: 200, height: 80 },
        },
        { tagName: "div", text: businessValue, sensitive: true },
      ],
    },
  ],
});

describe("page-model privacy boundary and structural fingerprints", () => {
  it("removes values, attributes, sensitive URL parameters, and capture channels", () => {
    const model = redactPageModel(raw("TEST-SENSITIVE-VALUE"));
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("TEST-SENSITIVE-VALUE");
    expect(serialized).not.toContain("record=");
    expect(serialized).not.toContain("secret");
    expect(model.report).toMatchObject({
      cookiesCaptured: false,
      storageCaptured: false,
      networkCaptured: false,
      sensitiveNodesRemoved: 1,
    });
    expect(model.report.valuesRemoved).toBeGreaterThan(0);
  });

  it("is stable across synthetic business values and compatible layout variants", () => {
    const a = createStructuralFingerprint(redactPageModel(raw("TEST-A", 24)));
    const b = createStructuralFingerprint(redactPageModel(raw("TEST-B", 28)));
    expect(a.sha256).toBe(b.sha256);
    expect(compareStructuralFingerprints(a, b)).toMatchObject({
      compatible: true,
      score: 1,
    });
  });

  it("rejects an incompatible structure with a required element missing", () => {
    const expected = createStructuralFingerprint(
      redactPageModel(raw("TEST-A")),
    );
    const actualModel = redactPageModel(raw("TEST-B"));
    actualModel.nodes[0].children = actualModel.nodes[0].children?.filter(
      (node) => node.label !== "Search",
    );
    const comparison = compareStructuralFingerprints(
      expected,
      createStructuralFingerprint(actualModel),
    );
    expect(comparison.compatible).toBe(false);
    expect(comparison.missingRequired).toContain("textbox:Search");
  });
});
