import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { modernManifestMatchesObservation, resolveModernManifestV8SourceContract } from '../project/manifest.js';
import type { DoctorLayer } from './doctor.js';

/** Bounded source observation only; doctor does not run or approve project recipes. */
export async function modernDoctorRuntime(projectRoot: string, manifest: LiftoffManifestV8): Promise<DoctorLayer> {
  const layer: DoctorLayer = { title: 'Runtime', checks: [] };
  const source = resolveModernManifestV8SourceContract({
    selection: { project: manifest.project, framework: manifest.framework, profile: manifest.governance.profile },
    recordedPlugins: manifest.plugins
  });
  const missing: string[] = source.layoutDescriptor.components.filter(component =>
    !manifest.activeLayout.bindings.some(binding => binding.kind === 'component' && binding.component === component));
  if (!manifest.activeLayout.bindings.some(binding => binding.kind === 'artifact' && binding.logicalName === 'docker-compose')) {
    missing.push('docker-compose');
  }
  if (manifest.activeLayout.state !== 'bound' || missing.length) {
    layer.checks.push({
      id: 'active-layout', label: 'active layout', severity: 'fail', state: 'not-observable',
      detail: manifest.activeLayout.state === 'unresolved' ? 'Active layout is unresolved.' : `Missing active bindings: ${missing.join(', ')}.`,
      remedy: 'Record reviewed active bindings before workload inspection; historical generation paths are not current layout authority.'
    });
  } else {
    const { inspectModernLocalRuntime } = await import('../governance/modern-local-inputs.js');
    const inspection = await inspectModernLocalRuntime(projectRoot);
    const blockers = inspection.status === 'blocked' ? inspection.blockers
      : !modernManifestMatchesObservation(manifest, inspection.installed.snapshot)
        ? ['The manifest changed during runtime observation.']
        : inspection.local.status === 'blocked' ? inspection.local.blockers
          : inspection.local.status !== 'modern-observed' ? ['The project no longer has a modern source boundary.'] : [];
    if (blockers.length) {
      layer.checks.push({
        id: 'project-inputs', label: 'project inputs', severity: 'fail', state: 'not-observable',
        detail: blockers.join('; '), remedy: 'Resolve the named source boundary before retrying; no project recipes were executed.'
      });
    } else if (inspection.status === 'observed' && inspection.local.status === 'modern-observed') {
      const { snapshot } = inspection.local;
      layer.checks.push({
        id: 'project-inputs', label: 'project inputs', severity: 'ok', state: 'observed',
        detail: `Bounded active-layout source captured: ${snapshot.files.filter(file => file.scope === 'application' && file.content !== null).length} files; ` +
          `${snapshot.exclusions.length} excluded entries were not read. This is source inventory, not workload verification.`
      });
    }
  }
  layer.checks.push({
    id: 'local-verification', label: 'local verification', severity: 'skipped', state: 'not-executed',
    detail: 'Project tests, builds, Compose and OpenTofu were not executed. Existing completion records are not fresh execution proof.'
  });
  return layer;
}
