import { defineConfig, devices } from "@playwright/test";

// The site is served by nginx as static files, so e2e runs against the real
// built output rather than the dev server — that is what actually ships, and
// it is the only way to catch pre-render and base-path regressions.
const PORT = 4178;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  // Both engines: Chromium and Firefox differ on history, focus and form
  // behaviour, which is exactly where a client-routed static site breaks.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  // A plain static file server, NOT `vite preview`. Preview applies an SPA
  // fallback, so /board/<slug> would serve index.html and quietly hide whether
  // the pre-rendered file exists — the single most important thing to test
  // before this is served by nginx from a directory. python's http.server
  // resolves directory indexes and 301s a missing trailing slash, which is
  // what nginx does.
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory dist`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
