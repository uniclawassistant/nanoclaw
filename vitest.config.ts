import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'container/**/*.test.ts',
    ],
    env: {
      CREDENTIAL_PROXY_HOST: '0.0.0.0',
    },
  },
});
