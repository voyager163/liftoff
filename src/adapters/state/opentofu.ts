import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  statefulRecipeVersion,
  type InspectedState,
  type PreparedStateMigration,
  type PrivateStateCommand,
  type PrivateStateCommandResult,
  type PrivateStateCommandRunner,
  type ProtectedStateWorkspace,
  type StateBackendKind,
  type StateConfigurationAttestation,
  type StateConfigurationProvider,
  type StateExecutionContext,
  type StateInstance,
  type StateMigrationPlan,
  type StateNativeDriver,
  type StateNativeReview,
  type StateRecipe,
  type StateRecipeQualification
} from '../../domain/repair/stateful.js';
import {
  assertNoResourceChanges, inspectStateBytes, isStateDigest, stateAssert, stateDigest, stateObjectDigest,
  validateStateMappings, validateStatePlanBindings, verifyStateAccounting
} from '../../domain/repair/stateful-invariants.js';
import { protectedStateScope } from './protected-workspace.js';
import { readPrivateNativeFile, writePrivateNativeFile } from './native-files.js';

export const implementedStateRecipeCombinations: readonly {
  recipe: StateRecipe;
  source: StateBackendKind;
  destinations: readonly StateBackendKind[];
  liveQualificationRequired: true;
}[] = (['local', 'azurerm'] as const).flatMap((source) => [
  { recipe: 'address-refactor' as const, source, destinations: [source], liveQualificationRequired: true as const },
  ...(['local', 'azurerm'] as const).map((destination) => ({
    recipe: 'backend-relocation' as const, source, destinations: [destination], liveQualificationRequired: true as const
  })),
  { recipe: 'state-partition' as const, source, destinations: ['local', 'azurerm'] as const, liveQualificationRequired: true as const }
]);

export type {
  StateConfigurationAttestation, StateConfigurationProvider, StateRecipeQualification
} from '../../domain/repair/stateful.js';

interface RootPlan {
  proofDigest: string;
  savedRef: string;
  savedDigest: string;
  exitCode: number;
  configurationDigest: string;
}

export class OpenTofuStateDriver implements StateNativeDriver {
  constructor(private readonly options: {
    workspace: ProtectedStateWorkspace;
    runner: PrivateStateCommandRunner;
    configurations: StateConfigurationProvider;
    qualification: StateRecipeQualification;
    now?: () => number;
  }) {}

  async quiesce(): Promise<void> {
    stateAssert(this.options.runner.quiesce, 'process-tree-termination-unproven');
    await this.options.runner.quiesce();
  }

  private async withScratch<T>(context: StateExecutionContext, action: (directory: string) => Promise<T>): Promise<T> {
    return this.options.workspace.withScratch(context, async (directory) => {
      try { return await action(directory); }
      finally { await this.quiesce(); }
    });
  }

  private async qualify(plan: Parameters<StateNativeDriver['review']>[0]): Promise<void> {
    stateAssert(plan.inspection.live, 'live-scope-required');
    validateStateMappings(plan.intent, plan.inspection.states);
    validateStatePlanBindings(plan.intent, plan.inspection.bindings);
    const source = plan.inspection.bindings.find((binding) => binding.id === plan.intent.sourceBackendId);
    stateAssert(source, 'mapping-incomplete');
    stateAssert(this.options.qualification, 'unqualified-combination');
    await this.options.qualification.assertQualified({
      recipeVersion: statefulRecipeVersion, recipe: plan.intent.recipe, source: source.kind,
      destinations: plan.intent.destinationBackendIds.map((id) => {
        const target = plan.inspection.bindings.find((binding) => binding.id === id);
        stateAssert(target, 'mapping-incomplete');
        return target.kind;
      }),
      executableDigest: this.options.runner.identityDigest, hostId: plan.context.hostId
    });
  }

  private async run(
    cwd: string, args: readonly string[], operation: PrivateStateCommand['operation'],
    signal?: AbortSignal, stdin?: Uint8Array, allowed = [0]
  ): Promise<PrivateStateCommandResult> {
    const result = await this.options.runner.run({ cwd, args, operation, signal, ...(stdin ? { stdin } : {}) });
    if (!allowed.includes(result.exitCode)) {
      result.stdout.fill(0);
      stateAssert(false, 'native-command-failed');
    }
    return result;
  }

  private async runQuiet(cwd: string, args: readonly string[], operation: PrivateStateCommand['operation'], signal?: AbortSignal, stdin?: Uint8Array): Promise<void> {
    const result = await this.run(cwd, args, operation, signal, stdin);
    result.stdout.fill(0);
  }

  private async backendConfiguration(directory: string, statePath: string): Promise<void> {
    await writePrivateNativeFile(path.join(directory, 'liftoff-state-backend.tf.json'), JSON.stringify({
      terraform: { backend: { local: { path: statePath } } }
    }));
  }

  private async minimalRoot(directory: string, statePath: string, signal?: AbortSignal): Promise<void> {
    await mkdir(directory, { mode: 0o700 });
    const mirror = path.join(directory, 'provider-mirror');
    await mkdir(mirror, { mode: 0o700 });
    await writePrivateNativeFile(path.join(directory, 'liftoff.private.tfrc'),
      `disable_checkpoint = true\nprovider_installation {\n  filesystem_mirror {\n    path = ${JSON.stringify(mirror)}\n  }\n}\n`);
    await this.backendConfiguration(directory, statePath);
    await this.runQuiet(directory, ['init', '-input=false', '-no-color', '-get=false'], 'inspect', signal);
  }

  private async materialize(reference: string, directory: string, context: StateExecutionContext, signal?: AbortSignal): Promise<StateConfigurationAttestation> {
    await mkdir(directory, { mode: 0o700 });
    const proof = await this.options.configurations.materialize(reference, directory, context, signal);
    stateAssert(proof?.stateFormat === 'opentofu-v4-json', 'unsupported-encryption');
    stateAssert(proof.configurationRef === reference && isStateDigest(proof.configurationDigest)
      && proof.artifactDigest === context.artifactDigest && proof.backendNeutral
      && proof.providerRegistration === 'disabled' && proof.provisioners.length === 0
      && proof.externalPrograms.length === 0 && proof.uninspectedDataSources.length === 0
      && proof.unresolvedModules.length === 0 && proof.moduleDigests.every(isStateDigest)
      && typeof proof.providerMirrorDirectory === 'string' && path.isAbsolute(proof.providerMirrorDirectory)
      && !/[\x00-\x1f]/.test(proof.providerMirrorDirectory)
      && proof.providers.length > 0 && proof.providers.every((provider) =>
        /^registry\.(?:opentofu|terraform)\.org\/hashicorp\/azurerm$/.test(provider.source)
        && /^\d+\.\d+\.\d+$/.test(provider.version) && isStateDigest(provider.binaryDigest)), 'unsafe-planning-contract');
    stateAssert(new Set(proof.providers.map((provider) => provider.source)).size === proof.providers.length, 'unsafe-planning-contract');
    await this.options.configurations.verifyMaterialized(reference, directory, proof, signal);
    await writePrivateNativeFile(path.join(directory, 'liftoff.private.tfrc'),
      `disable_checkpoint = true\nprovider_installation {\n  filesystem_mirror {\n    path = ${JSON.stringify(proof.providerMirrorDirectory)}\n    include = ${JSON.stringify(proof.providers.map((provider) => provider.source))}\n  }\n}\n`);
    return proof;
  }

  private async copyState(state: InspectedState, destination: string, context: StateExecutionContext): Promise<void> {
    stateAssert(state.stateRef && state.snapshot.digest, 'artifact-integrity');
    const bytes = await this.options.workspace.get(state.stateRef, 'state', protectedStateScope(context));
    try {
      stateAssert(stateDigest(bytes) === state.snapshot.digest, 'artifact-integrity');
      await writePrivateNativeFile(destination, bytes, true);
    } finally { bytes.fill(0); }
  }

  private verifyPlannedIdentities(plan: Record<string, unknown>, expected: readonly StateInstance[]): void {
    const plannedValues = plan.planned_values as { root_module?: unknown } | undefined;
    stateAssert(plannedValues && typeof plannedValues === 'object', 'verification-incomplete');
    const found = new Map<string, string>();
    const visit = (value: unknown): void => {
      stateAssert(value && typeof value === 'object', 'verification-incomplete');
      const module = value as {
        resources?: { address: string; values?: { id?: unknown } }[];
        child_modules?: unknown[];
      };
      stateAssert(module.resources === undefined || Array.isArray(module.resources), 'verification-incomplete');
      for (const resource of module.resources ?? []) {
        stateAssert(typeof resource.address === 'string' && typeof resource.values?.id === 'string' && !found.has(resource.address), 'verification-incomplete');
        found.set(resource.address, stateDigest(resource.values.id));
      }
      stateAssert(module.child_modules === undefined || Array.isArray(module.child_modules), 'verification-incomplete');
      for (const child of module.child_modules ?? []) visit(child);
    };
    visit(plannedValues.root_module ?? {});
    stateAssert(found.size === expected.length && expected.every((instance) => found.get(instance.address) === instance.identityDigest), 'resource-identity-changed');
  }

  private async rootPlan(request: {
    reference: string;
    directory: string;
    statePath: string;
    context: StateExecutionContext;
    instances: readonly StateInstance[];
    strict: boolean;
    operation: PrivateStateCommand['operation'];
    signal?: AbortSignal;
    applyPrivateStateOnly?: boolean;
    expectedConfigurationDigest?: string;
  }): Promise<RootPlan> {
    const attestation = await this.materialize(request.reference, request.directory, request.context, request.signal);
    stateAssert(request.expectedConfigurationDigest === undefined || request.expectedConfigurationDigest === attestation.configurationDigest, 'configuration-changed');
    await this.backendConfiguration(request.directory, request.statePath);
    await this.runQuiet(request.directory, ['init', '-input=false', '-no-color', '-get=false', '-lockfile=readonly'], 'inspect', request.signal);
    const saved = path.join(request.directory, 'reviewed.tfplan');
    const result = await this.run(request.directory, [
      'plan', '-input=false', '-no-color', '-refresh=true', '-lock=true', '-lock-timeout=10s',
      '-detailed-exitcode', `-out=${saved}`
    ], request.operation, request.signal, undefined, [0, 2]);
    result.stdout.fill(0);
    const shown = await this.run(request.directory, ['show', '-json', saved], 'inspect', request.signal);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(Buffer.from(shown.stdout).toString('utf8')) as Record<string, unknown>; }
    catch { stateAssert(false, 'verification-incomplete'); }
    finally { shown.stdout.fill(0); }
    stateAssert(typeof parsed.format_version === 'string' && /^1\.\d+$/.test(parsed.format_version), 'verification-incomplete');
    assertNoResourceChanges(parsed, request.strict);
    this.verifyPlannedIdentities(parsed, request.instances);
    if (request.strict) stateAssert(result.exitCode === 0, 'verification-incomplete');
    await this.options.configurations.verifyMaterialized(request.reference, request.directory, attestation, request.signal);
    const bytes = await readPrivateNativeFile(saved, 64 * 1024 * 1024);
    let savedRef: string;
    let savedDigest: string;
    try {
      const artifact = await this.options.workspace.put('plan', protectedStateScope(request.context), bytes);
      savedRef = artifact.ref;
      savedDigest = artifact.digest;
    }
    finally { bytes.fill(0); }
    if (request.applyPrivateStateOnly) {
      stateAssert(request.operation === 'transform', 'unsafe-planning-contract');
      await this.runQuiet(request.directory, ['apply', '-input=false', '-no-color', saved], 'transform', request.signal);
    }
    return {
      proofDigest: stateObjectDigest({
        config: attestation.configurationDigest, plan: stateObjectDigest(parsed),
        binary: this.options.runner.identityDigest, refresh: true
      }),
      savedRef, savedDigest, exitCode: result.exitCode, configurationDigest: attestation.configurationDigest
    };
  }

  async review(request: Parameters<StateNativeDriver['review']>[0]): Promise<StateNativeReview> {
    await this.qualify(request);
    return this.withScratch(request.context, async (directory) => {
      const source = request.inspection.states.find((state) => state.snapshot.backendId === request.intent.sourceBackendId)!;
      const sourcePath = path.join(directory, 'source.tfstate');
      await this.copyState(source, sourcePath, request.context);
      const contracts: StateConfigurationAttestation[] = [];
      let index = 0;
      for (const reference of Object.values(request.intent.targetConfigurationRefs)) {
        contracts.push(await this.materialize(reference, path.join(directory, `inspect-target-${index++}`), request.context, request.signal));
      }
      stateAssert(stateObjectDigest(contracts.map((entry) => [entry.configurationRef, entry.configurationDigest]).sort()) === request.intent.targetConfigurationDigest, 'configuration-changed');
      const sourceRoot = path.join(directory, 'source-plan');
      const proof = await this.rootPlan({
        reference: request.intent.sourceConfigurationRef, directory: sourceRoot, statePath: sourcePath,
        context: request.context, instances: source.instances, strict: true, operation: 'inspect', signal: request.signal
      });
      // Preview validates native address syntax without moving even private state.
      for (const mapping of request.intent.mappings) {
        if (mapping.sourceAddress === mapping.destinationAddress || mapping.disposition === 'preserve') continue;
        await this.runQuiet(sourceRoot, [
          'state', 'mv', '-dry-run', '-lock=true', '-lock-timeout=10s', `-state=${sourcePath}`,
          mapping.sourceAddress, mapping.destinationAddress
        ], 'inspect', request.signal);
      }
      return {
        configurationDigest: request.context.configurationDigest,
        configurationDigests: Object.fromEntries([
          ...contracts.map((contract) => [contract.configurationRef, contract.configurationDigest]),
          [request.intent.sourceConfigurationRef, proof.configurationDigest]
        ]),
        contractDigest: stateObjectDigest({ contracts, binary: this.options.runner.identityDigest }),
        savedPlanRefs: [proof.savedRef], savedPlanDigests: [proof.savedDigest]
      };
    });
  }

  private async privateState(
    backendId: string, filename: string, original: InspectedState, context: StateExecutionContext, purpose: 'state' | 'candidate'
  ): Promise<InspectedState> {
    const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      stateAssert(error.code === 'ENOENT', 'unsafe-path');
      return null;
    });
    if (!info) {
      const empty = inspectStateBytes({
        ...original.snapshot, backendId, exists: false, version: null, etag: null, size: 0
      }, null);
      return { ...empty, stateRef: null };
    }
    stateAssert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'unsafe-path');
    stateAssert(info.size > 0 && info.size <= 32 * 1024 * 1024, 'invalid-state');
    const bytes = await readPrivateNativeFile(filename, 32 * 1024 * 1024);
    try {
      const inspected = inspectStateBytes({
        ...original.snapshot, backendId, exists: true, size: bytes.byteLength,
        observedAt: this.options.now?.() ?? Date.now()
      }, bytes);
      const saved = await this.options.workspace.put(purpose, protectedStateScope(context), bytes);
      return { ...inspected, stateRef: saved.ref };
    } finally { bytes.fill(0); }
  }

  async prepare(plan: StateMigrationPlan, signal?: AbortSignal): Promise<PreparedStateMigration> {
    await this.qualify({ context: plan.context, inspection: plan.inspection, intent: plan.intent, signal });
    return this.withScratch(plan.context, async (directory) => {
      const contracts: StateConfigurationAttestation[] = [];
      let contractIndex = 0;
      for (const reference of Object.values(plan.intent.targetConfigurationRefs)) {
        contracts.push(await this.materialize(reference, path.join(directory, `recheck-target-${contractIndex++}`), plan.context, signal));
      }
      stateAssert(stateObjectDigest(contracts.map((entry) => [entry.configurationRef, entry.configurationDigest]).sort()) === plan.intent.targetConfigurationDigest
        && stateObjectDigest({ contracts, binary: this.options.runner.identityDigest }) === plan.review.contractDigest, 'configuration-changed');
      for (let index = 0; index < plan.review.savedPlanRefs.length; index++) {
        const bytes = await this.options.workspace.get(plan.review.savedPlanRefs[index], 'plan', protectedStateScope(plan.context));
        try { stateAssert(stateDigest(bytes) === plan.review.savedPlanDigests[index], 'artifact-integrity'); }
        finally { bytes.fill(0); }
      }
      const source = plan.inspection.states.find((state) => state.snapshot.backendId === plan.intent.sourceBackendId)!;
      const filenames = Object.fromEntries(plan.inspection.states.map((state, index) => [state.snapshot.backendId, path.join(directory, `state-${index}.tfstate`)]));
      const sourcePath = filenames[plan.intent.sourceBackendId];
      await this.copyState(source, sourcePath, plan.context);
      const nativeRoot = path.join(directory, 'native');
      await this.minimalRoot(nativeRoot, sourcePath, signal);
      if (plan.intent.recipe === 'backend-relocation') {
        const destinationPath = filenames[plan.intent.destinationBackendIds[0]];
        await this.backendConfiguration(nativeRoot, destinationPath);
        await this.runQuiet(nativeRoot, [
          'init', '-migrate-state', '-input=true', '-no-color', '-get=false', '-lock-timeout=10s'
        ], 'transform', signal, Buffer.from('yes\n'));
      } else {
        for (const mapping of plan.intent.mappings) {
          if (mapping.disposition === 'preserve'
            || (mapping.destinationBackendId === plan.intent.sourceBackendId && mapping.sourceAddress === mapping.destinationAddress)) continue;
          await this.runQuiet(nativeRoot, [
            'state', 'mv', '-lock=true', '-lock-timeout=10s', `-state=${sourcePath}`,
            ...(mapping.destinationBackendId === plan.intent.sourceBackendId ? [] : [`-state-out=${filenames[mapping.destinationBackendId]}`]),
            mapping.sourceAddress, mapping.destinationAddress
          ], 'transform', signal);
        }
      }
      const preliminary: Record<string, InspectedState> = {};
      for (const state of plan.inspection.states) {
        const id = state.snapshot.backendId;
        if (plan.intent.recipe === 'backend-relocation' && id === plan.intent.sourceBackendId) continue;
        preliminary[id] = await this.privateState(id, filenames[id], state, plan.context, 'candidate');
      }
      verifyStateAccounting(plan.intent, source, preliminary, true);
      const candidates: Record<string, InspectedState> = {};
      const proofs: string[] = [];
      let index = 0;
      for (const [id, candidate] of Object.entries(preliminary)) {
        if (candidate.instances.length === 0) continue;
        const reference = plan.intent.targetConfigurationRefs[id];
        stateAssert(reference, 'mapping-incomplete');
        await this.rootPlan({
          reference, directory: path.join(directory, `target-prepare-${index}`), statePath: filenames[id],
          context: plan.context, instances: candidate.instances, strict: false, operation: 'transform',
          applyPrivateStateOnly: true, signal, expectedConfigurationDigest: plan.review.configurationDigests[reference]
        });
        const prepared = await this.privateState(id, filenames[id], candidate, plan.context, 'candidate');
        const verified = await this.rootPlan({
          reference, directory: path.join(directory, `target-verify-${index++}`), statePath: filenames[id],
          context: plan.context, instances: prepared.instances, strict: true, operation: 'inspect', signal,
          expectedConfigurationDigest: plan.review.configurationDigests[reference]
        });
        candidates[id] = prepared;
        proofs.push(verified.proofDigest);
      }
      verifyStateAccounting(plan.intent, source, candidates, false);
      return { candidates, verificationDigest: stateObjectDigest(proofs) };
    });
  }

  async verify(plan: StateMigrationPlan, current: Readonly<Record<string, InspectedState>>, signal?: AbortSignal): Promise<string> {
    await this.qualify({ context: plan.context, inspection: plan.inspection, intent: plan.intent, signal });
    const source = plan.inspection.states.find((state) => state.snapshot.backendId === plan.intent.sourceBackendId)!;
    verifyStateAccounting(plan.intent, source, current, false);
    return this.verifyRoots(plan, current, signal);
  }

  async verifyDestinations(plan: StateMigrationPlan, current: Readonly<Record<string, InspectedState>>, signal?: AbortSignal): Promise<string> {
    await this.qualify({ context: plan.context, inspection: plan.inspection, intent: plan.intent, signal });
    const ids = new Set(plan.intent.destinationBackendIds);
    stateAssert(Object.keys(current).length === ids.size && Object.keys(current).every((id) => ids.has(id)), 'mapping-incomplete');
    const source = plan.inspection.states.find((state) => state.snapshot.backendId === plan.intent.sourceBackendId)!;
    const mappings = plan.intent.mappings.filter((mapping) => ids.has(mapping.destinationBackendId));
    verifyStateAccounting({ ...plan.intent, mappings }, source, current, false);
    return this.verifyRoots(plan, current, signal);
  }

  private async verifyRoots(plan: StateMigrationPlan, current: Readonly<Record<string, InspectedState>>, signal?: AbortSignal): Promise<string> {
    return this.withScratch(plan.context, async (directory) => {
      const proofs: string[] = [];
      let index = 0;
      for (const [id, state] of Object.entries(current)) {
        if (!state.snapshot.exists || state.instances.length === 0) continue;
        const filename = path.join(directory, `verify-${index}.tfstate`);
        await this.copyState(state, filename, plan.context);
        const proof = await this.rootPlan({
          reference: plan.intent.targetConfigurationRefs[id], directory: path.join(directory, `verify-root-${index++}`),
          statePath: filename, context: plan.context, instances: state.instances, strict: true, operation: 'inspect', signal,
          expectedConfigurationDigest: plan.review.configurationDigests[plan.intent.targetConfigurationRefs[id]]
        });
        proofs.push(proof.proofDigest);
      }
      return stateObjectDigest(proofs);
    });
  }
}
