import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'remote',
          environment: 'node',
          include: ['packages/remote/test/**/*.test.js'],
        },
      },
      // Runs inside workerd with the Worker and its Durable Object from wrangler.toml.
      'packages/server/vitest.config.js',
    ],
  },
});
