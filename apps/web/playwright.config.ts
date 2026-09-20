import { defineConfig } from '@playwright/test';

// Critical journeys per §20: onboarding, funding, AI use, limits, receipt, refund.
// Add them under e2e/ as the flows land; there is deliberately no placeholder spec.
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000' },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
});
