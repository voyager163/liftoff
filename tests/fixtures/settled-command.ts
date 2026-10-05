import type { ExternalCommand } from '../../src/domain/project/contracts.js';
import type { CommandRunner, RunCommandOptions } from '../../src/process-runner.js';

export async function runSettledFixtureCommand(
  runner: CommandRunner, command: ExternalCommand, options: RunCommandOptions,
  ownership: { root: string; retain: () => void }
) {
  let result;
  try { result = await runner.run(command, options); }
  catch (error) {
    ownership.retain();
    throw new Error(`Native dispatch is uncertain; fixture retained at ${ownership.root}.`, { cause: error });
  }
  if (result.processTreeSettled !== true && result.processSpawned !== false) {
    ownership.retain();
    throw new Error(`Native process settlement is uncertain; fixture retained at ${ownership.root}.`);
  }
  return result;
}
