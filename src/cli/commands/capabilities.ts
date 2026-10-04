import { installedCapabilities } from '../../application/capabilities.js';
import type { ExecutionContext } from '../../application/context.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import { commandDefinitions } from '../args/definitions.js';
import { getGeneralHelp } from '../args/help.js';
import { readBooleanFlag } from '../args/readers.js';

export function capabilitiesCommand(parsed: ParsedArgs, context: ExecutionContext): number {
  const installed = installedCapabilities();
  const report = {
    ...installed,
    globalOptions: getGeneralHelp(installed.cliVersion).globalOptions,
    commands: Object.entries(commandDefinitions).map(([name, definition]) => ({
      name,
      subcommands: [...definition.subcommands ?? []],
      defaultMaxPositionals: definition.defaultMaxPositionals,
      subcommandMaxPositionals: { ...definition.subcommandMaxPositionals },
      flags: Object.entries(definition.flags).map(([name, flag]) => ({
        name, kind: flag.kind, negatable: flag.negatable === true
      }))
    }))
  };
  if (readBooleanFlag(parsed.flags, 'json') === true) {
    context.presentation.rawStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    context.presentation.commandIdentity('capabilities', 'Installed public interfaces; no project or readiness probes');
    context.presentation.definitions('Release contracts', [
      { label: 'CLI version', value: report.cliVersion },
      { label: 'Capability schema', value: String(report.schemaVersion) },
      { label: 'Manifest readers', value: report.schemas.manifestRead.join(', ') },
      { label: 'Modern v8 read-only', value: report.schemas.modernReadOnly.commands.join(', ') },
      { label: 'Modern v8 verification', value: report.schemas.modernLocalVerification.selector },
      { label: 'Modern v8 finalization', value: report.schemas.modernLocalCompletion.selectors.finalize },
      { label: 'Modern v8 publication', value: report.schemas.modernLocalCompletion.selectors.publish },
      { label: 'Workflows', value: report.workflows.map(({ id }) => id).join(', ') },
      { label: 'Profiles', value: report.profiles.map(({ id }) => id).join(', ') },
      { label: 'Bundled plugins', value: String(report.plugins.inventory.length) },
      { label: 'Runtime', value: `Node.js ${report.runtime.minimumNodeVersion} or newer; no native distribution` }
    ]);
    context.presentation.table('Registered commands', ['Command', 'Subcommands'],
      report.commands.map(({ name, subcommands }) => [name, subcommands.join(', ') || '-']));
    context.presentation.bullets('Limitations', [
      report.governance.scope, report.runtime.hostSupport, report.runtime.readiness,
      report.boundaries.privateApis, report.boundaries.registration, report.schemas.modernReadOnly.scope,
      report.schemas.modernLocalVerification.scope,
      report.schemas.modernLocalCompletion.scope,
      'Public stateful migration and project telemetry enrollment are unavailable.',
      'Use liftoff capabilities --json for exact schemas, recipes and per-phase executor blockers.',
      'Capability discovery is not approval to execute or modify anything.'
    ]);
  }
  return 0;
}
