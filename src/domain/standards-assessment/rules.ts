import { SUPPORTED_STANDARDS_PROFILE_IDS } from '../standards/profile-schema.js';
import type { RuleDefinition } from './types.js';

const all = [...SUPPORTED_STANDARDS_PROFILE_IDS];
const backends = all.filter((id) => id !== 'vue-component');
const genai = all.filter((id) => id.startsWith('genai-'));

export const STANDARDS_RULES: readonly RuleDefinition[] = [
  { id: 'STD-LIFTOFF-MANIFEST', title: 'Liftoff Project Manifest', description: 'Root manifest validation and lifecycle conformance',
    severity: 'warning', applicableProfiles: all, applicableScope: 'project', expected: 'Root manifest validation and lifecycle conformance' },
  { id: 'STD-DEP-LOCK', title: 'Dependency Declarations and Frozen Lockfile', description: 'Pinned lockfile presence and integrity verification',
    severity: 'error', applicableProfiles: all, applicableScope: 'component', expected: 'Pinned lockfile presence and integrity verification' },
  { id: 'STD-API-HEALTH', title: 'Health Check Endpoint', description: 'Deterministic health endpoint returning status ok',
    severity: 'warning', applicableProfiles: backends, applicableScope: 'component', expected: 'Deterministic health endpoint returning status ok' },
  { id: 'STD-API-DOCS', title: 'OpenAPI Documentation Route', description: 'Prefix-safe OpenAPI/Scalar documentation route',
    severity: 'info', applicableProfiles: backends, applicableScope: 'component', expected: 'Prefix-safe OpenAPI/Scalar documentation route' },
  { id: 'STD-TEST-SUITE', title: 'Automated Test Suite', description: 'Integrated automated test suite passing in private workspace',
    severity: 'warning', applicableProfiles: all, applicableScope: 'component', expected: 'Integrated automated test suite passing in private workspace' },
  { id: 'STD-CONT-COMPOSE', title: 'Containerization Declarations', description: 'Multi-service container orchestration declaration',
    severity: 'info', applicableProfiles: backends, applicableScope: 'project', expected: 'Multi-service container orchestration declaration' },
  { id: 'STD-FRONTEND-ENTRY', title: 'Frontend Entrypoint and Root Component', description: 'Vue 3 main.ts and App.vue root component',
    severity: 'warning', applicableProfiles: ['vue-component'], applicableScope: 'component', expected: 'Vue 3 main.ts and App.vue root component' },
  { id: 'STD-FRONTEND-BUILD', title: 'Frontend Build Configuration', description: 'Vite and Tailwind CSS build configuration',
    severity: 'info', applicableProfiles: ['vue-component'], applicableScope: 'component', expected: 'Vite and Tailwind CSS build configuration' },
  { id: 'STD-GENAI-MODEL-CONFIG', title: 'GenAI Model Configuration', description: 'Deterministic model and provider configuration',
    severity: 'warning', applicableProfiles: genai, applicableScope: 'component', expected: 'Deterministic model and provider configuration' },
  { id: 'STD-GENAI-PATTERN-CONTRACT', title: 'GenAI Pattern Contract', description: 'Honest pattern-specific implementation route',
    severity: 'warning', applicableProfiles: genai, applicableScope: 'component', expected: 'Honest pattern-specific implementation route' },
  { id: 'STD-FRAMEWORK-OPENSPEC', title: 'Spec-Driven Framework Setup', description: 'Initialized OpenSpec or Spec Kit workflow',
    severity: 'info', applicableProfiles: all, applicableScope: 'project', expected: 'Initialized OpenSpec or Spec Kit workflow' },
  { id: 'STD-INFRA-OPENTOFU', title: 'Infrastructure Declarations', description: 'Validated applicable OpenTofu infrastructure',
    severity: 'info', applicableProfiles: backends, applicableScope: 'project', expected: 'Validated applicable OpenTofu infrastructure' }
];

export function normalizeRuleId(ruleId: string): string {
  if (ruleId === 'RULE-FRONTEND-PACKAGE') return 'STD-DEP-LOCK';
  return ruleId.startsWith('RULE-') ? ruleId.replace(/^RULE-/u, 'STD-') : ruleId;
}

export function getRuleDefinition(ruleId: string): RuleDefinition | undefined {
  const rule = STANDARDS_RULES.find((entry) => entry.id === normalizeRuleId(ruleId));
  if (!rule) return undefined;
  return {
    ...rule, id: ruleId,
    ...(ruleId === 'RULE-FRONTEND-PACKAGE' ? {
      description: 'Frontend package.json and locked dependencies', expected: 'Frontend package.json and locked dependencies',
      applicableProfiles: ['vue-component']
    } : {})
  };
}
