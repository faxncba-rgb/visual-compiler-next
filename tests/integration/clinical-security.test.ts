import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  browserProfiles,
  compatibilityProbe,
} from "@visual-compiler/clinical-safety";
import {
  isOpenAIHostname,
  runLocalCompatibilityProbe,
} from "@visual-compiler/runtime";

describe("clinical runtime security invariants", () => {
  it("has no OpenAI import or dependency in runtime", async () => {
    const source = await readFile("packages/runtime/src/index.ts", "utf8");
    const pkg = await readFile("packages/runtime/package.json", "utf8");
    expect(source).not.toMatch(/from ["']openai["']/);
    expect(JSON.parse(pkg).dependencies).not.toHaveProperty("openai");
  });

  it("blocks HTTP and WebSocket OpenAI access and service workers", async () => {
    const source = await readFile("packages/runtime/src/index.ts", "utf8");
    expect(source).toContain('serviceWorkers: "block"');
    expect(source).toContain('route.abort("blockedbyclient")');
    expect(source).toContain("routeWebSocket");
    expect(isOpenAIHostname("api.openai.com")).toBe(true);
    expect(isOpenAIHostname("OPENAI.COM.")).toBe(true);
    expect(isOpenAIHostname("openai.com.example.org")).toBe(false);
  });

  it("keeps clinical compilation unavailable and probe disabled", async () => {
    const studio = await readFile("apps/studio/backend/src/server.ts", "utf8");
    expect(browserProfiles.clinical.compilationAllowed).toBe(false);
    expect(studio).toContain("/api/clinical/compile");
    expect(studio).toContain("status(403)");
    expect(compatibilityProbe).toMatchObject({
      enabledByDefault: false,
      realTargetExecuted: false,
      callsLlm: false,
    });
    await expect(
      runLocalCompatibilityProbe({
        url: "https://example.invalid/",
        authorizedEnvironmentConfirmed: true,
        explicitUserAction: true,
      }),
    ).rejects.toThrow(/disabled by default/);
  });
});
