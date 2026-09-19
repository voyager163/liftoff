import { canonicalSha256 } from './canonical-json.js';
import { canonicalPhaseGraph } from './graph.js';
                                                                                        
import { phaseScope } from './types.js';

                                      
               
                 
 

export function isProjectMutationReservationName(name        )          {
  return /^\.liftoff-mutation-[a-f0-9]{64}\.lock$/.test(name);
}

                                          
                   
                   
                                        
        
                        
                          
                                
    
                      
                              
                                                           
 

const publicEnvironmentKeys = new Set([
  'APP_NAME', 'APP_ENV', 'ENVIRONMENT', 'LOG_LEVEL', 'PORT', 'HOST', 'CORS_ORIGINS',
  'MODEL_PROVIDER', 'MODEL_NAME', 'AI_MODEL_PROVIDER', 'AI_MODEL_NAME', 'AI_MODEL_ID',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'OPENAI_MODEL', 'OLLAMA_BASE_URL',
  'LANGFUSE_HOST', 'OTEL_SERVICE_NAME', 'OTEL_EXPORTER_OTLP_ENDPOINT',
  'MESSAGING_TRANSPORT', 'REDIS_STREAM', 'REDIS_STREAM_NAME', 'SERVICE_BUS_NAMESPACE',
  'SERVICE_BUS_QUEUE_NAME', 'SERVICEBUS_FULLY_QUALIFIED_NAMESPACE', 'SERVICEBUS_QUEUE_NAME'
]);

export function normalizedPublicEnvironment(text        )                         {
  const result                         = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !publicEnvironmentKeys.has(match[1] )) continue;
    let value = match[2] .trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (value.includes('${')) throw new Error(`Public configuration ${match[1]} has unresolved interpolation; no project configuration is executed.`);
    if (/https?:\/\/[^/]*@/i.test(value) || /[?&](?:token|key|secret|sig)=/i.test(value)) continue;
    result[match[1] ] = value;
  }
  return result;
}

export function normalizedSeedInput(text        )         {
  return text.replace(/\r\n/g, '\n').replace(/^(\s*-\s+\[)[xX](\])/gm, '$1 $2');
}

export function activationBaselineDigest(project         , files                                )         {
  return canonicalSha256({ schemaVersion: 2, project, files: [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')) });
}

export function phaseInputFiles(phaseId         , snapshot                         )                                 {
  const workflow = (file                     ) =>
    file.path.startsWith('.github/workflows/') || file.path.startsWith('.github/actions/') ||
    file.path.startsWith('.github/rulesets/') || file.path.startsWith('governance/rulesets/');
  if (phaseId === 'committed' || phaseId === 'pushed') {
    return snapshot.files.filter((file) => file.path !== 'governance/credentials/preflight-policy.json');
  }
  if (['seed-valid', 'seed-verified', 'seed-archived', 'activation-approved'].includes(phaseId)) {
    // Workflow publication is qualified by its own phases, not by local application checks.
    return snapshot.files.filter((file) => !workflow(file) && file.path !== 'governance/credentials/preflight-policy.json');
  }
  if (phaseId === 'bootstrap-workflow-source-ready' || phaseId === 'credential-ready' ||
    phaseId === 'runner-ready' || phaseId === 'private-backend-proof') {
    return snapshot.files.filter((file) =>
      file.path.startsWith('.github/workflows/liftoff-bootstrap') ||
      file.path === '.github/workflows/bootstrap-import-preflight.yml' ||
      file.path === '.github/workflows/private-dast-preflight.yml' ||
      file.path.startsWith('.github/actions/') ||
      file.path === 'governance/credentials/preflight-policy.json'
    );
  }
  if (phaseId === 'phase-0-complete' || phaseId === 'state-path-selected' ||
    phaseId === 'bootstrap-state-disposed') {
    return snapshot.files.filter((file) => file.path.startsWith('.liftoff/governance/'));
  }
  if (['provider-ready', 'existing-private-path', 'bootstrap-local', 'remote-import-verified', 'remote-ready', 'application-prerequisites-ready'].includes(phaseId)) {
    return snapshot.files.filter((file) => file.path.startsWith('infrastructure/') || file.path.startsWith('.liftoff/governance/'));
  }
  return snapshot.files;
}

                                 
                      
                 
                 
                  
 

const none = { repository: false, azure: false, phase: false, budget: false }         ;
const repository = { repository: true, azure: false, phase: true, budget: false }         ;
const azure = { repository: false, azure: true, phase: true, budget: false }         ;
const infrastructure = { repository: true, azure: true, phase: true, budget: true }         ;

export const phaseConsumedConfiguration                                                   = {
  'seed-valid': none,
  'seed-verified': none,
  'seed-archived': none,
  committed: repository,
  pushed: repository,
  'repository-discovered': repository,
  'repository-workflow-source-ready': repository,
  'repository-checks-qualified': repository,
  'repository-enforcement-approved': repository,
  'repository-rulesets-applied': repository,
  'repository-live-readback': repository,
  'phase-0-complete': { ...repository, azure: true },
  'activation-approved': infrastructure,
  'bootstrap-workflow-source-ready': repository,
  'credential-ready': repository,
  'provider-ready': azure,
  'state-path-selected': azure,
  'existing-private-path': azure,
  'bootstrap-local': infrastructure,
  'runner-ready': infrastructure,
  'private-backend-proof': { ...repository, azure: true },
  'remote-import-verified': infrastructure,
  'remote-ready': azure,
  'application-prerequisites-ready': infrastructure,
  'workflow-source-ready': repository,
  'application-artifact-ready': infrastructure,
  'application-foundation': infrastructure,
  'dev-proof': { ...repository, azure: true },
  'staging-qualified': infrastructure,
  'production-rehearsed': infrastructure,
  'green-red-proof': repository,
  'enforcement-approved': repository,
  'rulesets-applied': repository,
  'live-readback': repository,
  'bootstrap-state-disposed': { ...none, phase: true }
};

export function providerSdkConfigurationProjection(configuration                          )                                    {
  const statePath = configuration?.phases['state-path-selected']?.statePath ?? null;
  return {
    statePath,
    bootstrap: statePath === 'bootstrap-local' ? configuration?.phases['bootstrap-local'] ?? null : null
  };
}

export function phaseConfigurationProjection(
  phaseId         , configuration                          
)                                    {
  const consumed = phaseConsumedConfiguration[phaseId];
  return {
    ...(consumed.repository ? { repository: configuration?.repository ?? null } : {}),
    ...(consumed.azure ? { azure: configuration?.azure ?? null } : {}),
    ...(consumed.phase ? { phase: configuration?.phases[phaseId] ?? null } : {}),
    ...(consumed.budget ? { budget: configuration?.budget ?? null } : {}),
    ...(phaseId === 'provider-ready' ? { sdk: providerSdkConfigurationProjection(configuration) } : {})
  };
}

export function phaseInputDigest(phaseId         , snapshot                         , state                      )         {
  const local = phaseScope(phaseId) === 'local';
  const dependencies = canonicalPhaseGraph.phases.find((phase) => phase.id === phaseId)?.dependencies ?? [];
  const parentOutputs = Object.fromEntries(dependencies.flatMap((dependency) => dependency.anyOf)
    .filter((id) => state?.phaseOutputs?.[id] !== undefined)
    .map((id) => [id, state .phaseOutputs [id]]));
  return canonicalSha256({
    schemaVersion: 4,
    phaseId,
    project: snapshot.project,
    files: phaseInputFiles(phaseId, snapshot),
    ...(snapshot.sensitivePathExclusions?.length ? {
      protectedPathsDigest: canonicalSha256(snapshot.sensitivePathExclusions)
    } : {}),
    ...(!local && phaseId !== 'committed' ? { pushUrls: snapshot.git.pushUrls } : {}),
    ...(phaseId === 'committed' || phaseId === 'pushed' ? {
      git: { head: snapshot.git.head, branch: snapshot.git.branch }
    } : {}),
    ...(!local ? {
      configuration: phaseConfigurationProjection(phaseId, state?.activationInputs),
      parentOutputs
    } : {})
  });
}

export function remoteBindingDigest(binding                                      )                     {
  if (!binding) return undefined;
  const { verifiedAt: _verifiedAt, ...identity } = binding;
  return canonicalSha256(identity);
}

export function remoteRepository(state                     )                                    {
  return state.remoteBinding ?? state.repository;
}

export function githubRepositoryFromPushUrl(url        )         {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error('A supported credential-free GitHub push destination is required for repository discovery.');
  return match[1] ;
}
