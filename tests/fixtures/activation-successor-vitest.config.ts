import { defineConfig } from 'vitest/config';
import { activationSuccessorProviderBoundary } from './activation-successor-runtime.js';

export default defineConfig({
  plugins: [activationSuccessorProviderBoundary()],
  test: { testTimeout: 30_000 }
});
