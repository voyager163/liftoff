import { readStringFlag } from '../args/readers.js';
import {
  listRegions,
  patterns,
  providers,
  resolveRegion,
  searchRegions
} from '../../application/project/catalog.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';

export function patternsCommand(context: ExecutionContext): number {
  context.presentation.commandIdentity('patterns', 'Available GenAI application patterns');
  context.presentation.table(
    'Patterns',
    ['Identifier', 'Pattern', 'Scaffold'],
    patterns.map((pattern) => [pattern.id, pattern.label, pattern.scaffoldStatus])
  );
  return 0;
}

export function providersCommand(context: ExecutionContext): number {
  context.presentation.commandIdentity('providers', 'Cloud provider availability');
  context.presentation.table(
    'Providers',
    ['Identifier', 'Provider', 'Availability'],
    providers.map((provider) => [provider.id, provider.label, provider.status])
  );
  return 0;
}

export function regionsCommand(parsed: ParsedArgs, context: ExecutionContext): number {
  const cloud = readStringFlag(parsed.flags, 'cloud') ?? 'azure';
  context.presentation.commandIdentity('regions', 'Cloud deployment regions');
  if (cloud !== 'azure') {
    context.presentation.error(
      `${cloud} regions are not available until the provider adapter is implemented.`,
      'Run `liftoff providers` to review currently available providers.'
    );
    return 1;
  }

  const filter = readStringFlag(parsed.flags, 'region');
  const query = parsed.positional[0] ?? filter;
  let regions = listRegions('azure');
  if (parsed.subcommand === 'search' && query) {
    regions = searchRegions('azure', query);
  } else if (filter !== undefined) {
    const resolution = resolveRegion('azure', filter);
    if (resolution.status !== 'resolved') {
      context.presentation.error(
        resolution.status === 'ambiguous'
          ? `Ambiguous Azure region ${JSON.stringify(filter)}. Choose: ${resolution.matches.map((region) => region.slug).join(', ')}.`
          : `Unknown Azure region: ${JSON.stringify(filter)}.`,
        'Run `liftoff regions` or `liftoff regions search <query>` to find an explicit region.'
      );
      return 1;
    }
    regions = [resolution.region];
  }
  if (regions.length === 0) {
    context.presentation.warning(`No Azure regions matched ${JSON.stringify(query ?? '')}.`);
    return 0;
  }
  context.presentation.table(
    query ? `Azure region matches for ${JSON.stringify(query)}` : 'Azure regions',
    ['Identifier', 'Region', 'Geography'],
    regions.map((region) => [region.slug, region.displayName, region.geography])
  );
  return 0;
}
