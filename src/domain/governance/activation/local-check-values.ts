import type { ExternalCommand } from '../../project/contracts.js';

export const specKitBootstrapId = '000-liftoff-bootstrap';
export const specKitBootstrapPath = ['specs', specKitBootstrapId] as const;
export const specKitBootstrapTaskIds = ['B001', 'B002', 'B003', 'B004', 'B005', 'B006'] as const;

export function appendSpecKitDocumentIssues(name: 'spec' | 'plan' | 'tasks', text: string, parts: readonly string[], issues: string[]): void {
  if (!text.includes(`Bootstrap identity: \`${specKitBootstrapId}\``)) {
    issues.push(`${parts.join('/')} must declare the real ${specKitBootstrapId} bootstrap identity, not a framework template.`);
  }
  if (name === 'spec' && !/^## Requirements\s*$/m.test(text)) issues.push('Bootstrap spec requires explicit requirements.');
  if (name === 'plan' && (!/^## Verification\s*$/m.test(text) || !text.includes('specs/000-liftoff-bootstrap/spec.md'))) {
    issues.push('Bootstrap plan must reference its real spec and local verification plan.');
  }
}

export function appendSpecKitTaskIssues(text: string, issues: string[]): void {
  for (const id of specKitBootstrapTaskIds) {
    if ([...text.matchAll(new RegExp(`^\\s*- \\[[ xX]\\] ${id} `, 'gm'))].length !== 1) {
      issues.push(`Bootstrap task ${id} must occur exactly once.`);
    }
  }
}

export function extractDeclaredCapabilities(proposal: string): string[] {
  const capabilities: string[] = [];
  const lines = proposal.split(/\r?\n/);
  let inNewCapabilities = false;
  for (const line of lines) {
    if (/^###\s+New Capabilities\s*$/i.test(line.trim())) {
      inNewCapabilities = true;
      continue;
    }
    if (inNewCapabilities && /^###\s+/.test(line.trim())) {
      break;
    }
    if (!inNewCapabilities) {
      continue;
    }
    const match = line.match(/^\s*-\s+`([^`]+)`:/);
    if (match) {
      capabilities.push(match[1]!);
    }
  }
  return capabilities;
}

export function mainSpecPurpose(markdown: string): string | null {
  const match = markdown.match(/^## Purpose\s*\r?\n+([\s\S]*?)(?=\r?\n##\s+)/mu);
  return match?.[1]?.trim() || null;
}

export function archivedOpenSpecMatchesMain(main: string, delta: string): boolean {
  // OpenSpec archive compacts blank lines after Purpose without changing its body.
  const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/^## Purpose\n+/mu, '## Purpose\n');
  return normalize(main).includes(normalize(delta).replace('## ADDED Requirements', '## Requirements'));
}

export function isSpecKitIntegrationRecord(parsed: unknown): parsed is Record<string, unknown> {
  return !(typeof parsed !== 'object' || parsed === null || Array.isArray(parsed));
}

export function appendSpecKitDefaultIssues(state: Record<string, unknown>, expectedDefault: string | undefined, issues: string[]): void {
  const defaultIntegration = state.default_integration ?? state.integration;
  if (state.default_integration !== undefined && state.integration !== undefined &&
      state.default_integration !== state.integration) {
    issues.push('Spec Kit integration and default_integration disagree.');
  }
  if (defaultIntegration !== expectedDefault) {
    issues.push(`Spec Kit default integration is ${JSON.stringify(defaultIntegration)}; expected ${JSON.stringify(expectedDefault)}.`);
  }
}

export function isSpecKitInstalledList(installed: unknown): installed is string[] {
  return !(!Array.isArray(installed) || installed.some((value) => typeof value !== 'string'));
}

export function appendSpecKitSelectedIssues(installed: readonly string[], expected: readonly string[], issues: string[]): void {
  for (const integration of expected) {
    if (!installed.includes(integration)) {
      issues.push(`Spec Kit integration state does not include selected integration ${integration}.`);
    }
  }
}

export function isOpenSpecCodexTarget(target: string): boolean { return target.trim() === 'codex'; }

export function liftoffValidationCommand(): ExternalCommand { return { executable: 'liftoff', args: ['validate'] }; }

export function pythonBackendCommand(project = 'backend', tests = 'backend/tests'): ExternalCommand { return { executable: 'uv', args: ['run', '--project', project, 'python', '-m', 'pytest', '-q', tests] }; }

export function nodeBackendCommand(): ExternalCommand { return { executable: 'npm', args: ['test'] }; }

export function goBackendCommand(): ExternalCommand { return { executable: 'go', args: ['test', './...'] }; }

export function workerTestCommand(project = '../../backend'): ExternalCommand { return { executable: 'uv', args: ['run', '--project', project, '--directory', '.', 'python', '-m', 'pytest', '-q'] }; }

export function frontendBuildCommand(): ExternalCommand { return { executable: 'npm', args: ['run', 'build'] }; }

export function composeConfigurationCommand(): ExternalCommand { return { executable: 'docker', args: ['compose', 'config', '-q'] }; }

export function tofuFormatCommand(): ExternalCommand { return { executable: 'tofu', args: ['fmt', '-check', '-recursive'] }; }

export function tofuInitCommand(): ExternalCommand { return { executable: 'tofu', args: ['init', '-backend=false'] }; }

export function tofuValidateCommand(): ExternalCommand { return { executable: 'tofu', args: ['validate'] }; }
