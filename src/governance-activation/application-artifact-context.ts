import { parseProjectManifest, type SupportedProjectManifest } from '../application/project/manifest.js';
import { resolveModernManifestSourceContext } from '../application/project/source-context.js';
import { GitHubActivationError } from '../adapters/github/activation-rest.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { applicationContextPaths } from './application-artifact-context-recipe.js';

const sourceComponents = new Set(['backend', 'database', 'frontend', 'function-worker']);
const contextArtifacts = new Set(['backend-dockerfile', 'root-dockerignore']);

export function bindApplicationArtifactContext(
  manifest: SupportedProjectManifest, value: unknown, dockerfilePath: string
) {
  manifest = parseProjectManifest(manifest);
  const paths = applicationContextPaths(value);
  let dockerfile: string | undefined;
  let allowed: (file: string) => boolean;
  if (manifest.artifactVersion === 8) {
    const context = resolveModernManifestSourceContext(manifest);
    if (context.activeLayout.state !== 'bound') {
      throw new GitHubActivationError('application-context-layout', 'Application context requires current bound layout metadata, not original generation paths.');
    }
    const components = context.activeLayout.bindings.filter(binding =>
      binding.kind === 'component' && sourceComponents.has(binding.component)).map(binding => binding.pathParts.join('/'));
    const artifacts = context.activeLayout.bindings.filter(binding => binding.kind === 'artifact' &&
      (contextArtifacts.has(binding.logicalName) ||
        sourceComponents.has(context.source.layoutDescriptor.artifacts.find(artifact =>
          artifact.logicalName === binding.logicalName)?.component ?? '')));
    dockerfile = artifacts.find(binding => binding.kind === 'artifact' &&
      binding.logicalName === 'backend-dockerfile')?.pathParts.join('/');
    allowed = file => artifacts.some(binding => binding.pathParts.join('/') === file) ||
      components.some(component => file.startsWith(`${component}/`));
  } else {
    const artifacts = manifest.projectArtifacts.filter(artifact =>
      contextArtifacts.has(artifact.logicalName) || ['backend', 'database', 'frontend', 'functions'].includes(artifact.pathParts[0]!));
    dockerfile = artifacts.find(artifact => artifact.logicalName === 'backend-dockerfile')?.pathParts.join('/');
    allowed = file => artifacts.some(artifact => artifact.pathParts.join('/') === file);
  }
  if (dockerfile !== dockerfilePath || !paths.includes(dockerfilePath) || paths.some(file => !allowed(file))) {
    throw new GitHubActivationError('application-context-layout',
      'Every context file and the actual Dockerfile must belong to the reviewed manifest/current active source layout; history is not current path authority.');
  }
  return { contextPaths: paths, sourceManifestDigest: canonicalSha256(manifest) };
}
