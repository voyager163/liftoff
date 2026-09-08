import {
  packagedSupportedStack,
  readSupportedStackBaseline
} from './adapters/packaged-assets/supported-stack.js';

export * from './domain/project/supported-stack.js';
export { readSupportedStackBaseline } from './adapters/packaged-assets/supported-stack.js';

export const supportedStack = packagedSupportedStack;
