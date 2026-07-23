import { describe, expect, it } from "vitest";
import { createRedactedCompilerPageModel } from "@visual-compiler/compiler";
import type { PageModel } from "@visual-compiler/page-model";

describe("compiler privacy boundary", () => {
  it("passes only structural fields and explicitly stable labels to the model boundary", () => {
    const model: PageModel = {
      url: "https://dpi-ncba.gbna-sante.fr/queue?patient=PRIVATE",
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
    expect(serialized).toContain("administrative-search");
    expect(redacted.redactionReport).toMatchObject({
      cookiesCaptured: false,
      storageCaptured: false,
      networkCaptured: false,
    });
  });
});
