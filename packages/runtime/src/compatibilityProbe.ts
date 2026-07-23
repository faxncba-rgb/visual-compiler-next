import { chromium } from "playwright";
import { CompatibilityProbeReportSchema } from "@visual-compiler/clinical-safety";

export type CompatibilityProbeOptions = {
  url: string;
  authorizedEnvironmentConfirmed: true;
  explicitUserAction: true;
};

export async function runLocalCompatibilityProbe(
  options: CompatibilityProbeOptions,
) {
  if (process.env.ENABLE_COMPATIBILITY_PROBE !== "true") {
    throw new Error("Compatibility probe is disabled by default.");
  }
  if (
    options.authorizedEnvironmentConfirmed !== true ||
    options.explicitUserAction !== true
  ) {
    throw new Error("Explicit authorization confirmation is required.");
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    serviceWorkers: "block",
    recordVideo: undefined,
  });
  const page = await context.newPage();
  try {
    await page.goto(options.url);
    const report = await page.evaluate(() => {
      const standardDomElements = document.querySelectorAll("*").length;
      const accessibleControls = document.querySelectorAll(
        "button,input,select,textarea,a[href],[role=button],[role=checkbox],[role=textbox],[role=combobox]",
      ).length;
      const iframesDetected = document.querySelectorAll("iframe").length;
      const canvasElementsDetected = document.querySelectorAll("canvas").length;
      const shadowRootsDetected = Array.from(
        document.querySelectorAll("*"),
      ).filter((element) => Boolean(element.shadowRoot)).length;
      const stableLabelsDetected = document.querySelectorAll(
        "label,[aria-label],[aria-labelledby]",
      ).length;
      const spaNavigationDetected =
        document.querySelectorAll("[data-reactroot],[data-v-app],[ng-version]")
          .length > 0;
      const compatibilityLevel =
        canvasElementsDetected > 0
          ? "low"
          : accessibleControls > 0
            ? "high"
            : "medium";
      const limitations = [
        ...(iframesDetected > 0
          ? ["iframes require separate authorization and inspection"]
          : []),
        ...(shadowRootsDetected > 0
          ? ["shadow DOM requires explicit locator support"]
          : []),
        ...(canvasElementsDetected > 0
          ? ["canvas controls are not structurally automatable"]
          : []),
      ];
      return {
        standardDomElements,
        accessibleControls,
        iframesDetected,
        shadowRootsDetected,
        canvasElementsDetected,
        spaNavigationDetected,
        stableLabelsDetected,
        compatibilityLevel,
        limitations,
      };
    });
    return CompatibilityProbeReportSchema.parse(report);
  } finally {
    await context.close();
    await browser.close();
  }
}
