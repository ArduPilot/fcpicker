import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Deliberately separate from vite.config.ts: that config registers the admin
// dev-server middleware, which has no business running under test.
export default defineConfig({
  plugins: [react()],
  // Test files live outside src/ and are not covered by the app tsconfig's
  // jsx setting, so the automatic runtime has to be stated here or JSX in a
  // spec compiles to React.createElement with no React import in scope.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // e2e specs are Playwright's; vitest must not try to collect them.
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/component/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/entry-server.tsx", "src/routes-config.tsx"],
    },
  },
});
