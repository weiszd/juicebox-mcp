import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.toml' },
    miniflare: { bindings: { SESSION_HMAC_SECRET: 'test-session-hmac-secret' } },
  })],
  test: {
    name: 'server',
    include: ['test/**/*.test.js'],
  },
});
