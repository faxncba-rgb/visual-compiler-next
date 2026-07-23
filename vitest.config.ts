import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromRoot = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@visual-compiler/semantic-ir": fromRoot(
        "./packages/semantic-ir/src/index.ts",
      ),
      "@visual-compiler/spatial": fromRoot("./packages/spatial/src/index.ts"),
      "@visual-compiler/page-model": fromRoot(
        "./packages/page-model/src/index.ts",
      ),
      "@visual-compiler/locator-engine": fromRoot(
        "./packages/locator-engine/src/index.ts",
      ),
      "@visual-compiler/compiler": fromRoot("./packages/compiler/src/index.ts"),
      "@visual-compiler/runtime": fromRoot("./packages/runtime/src/index.ts"),
      "@visual-compiler/shared": fromRoot("./packages/shared/src/index.ts"),
      "@visual-compiler/clinical-safety": fromRoot(
        "./packages/clinical-safety/src/index.ts",
      ),
    },
  },
});
