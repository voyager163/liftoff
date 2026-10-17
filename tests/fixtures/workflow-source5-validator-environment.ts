import { environmentValue } from '../../src/domain/workstation/executables.js';

export function matrixValidatorEnvironment(home: string, platform: NodeJS.Platform = process.platform,
  ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { HOME: home, NODE_OPTIONS: '' };
  if (platform !== 'win32') return environment;
  const systemRoot = environmentValue(ambient, 'SystemRoot', 'win32');
  if (!systemRoot) throw new Error('The owned Windows validator requires the actual host SystemRoot.');
  return { ...environment, SystemRoot: systemRoot };
}
