#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import {
  auditTemplateDependencyInventory,
  canonicalNpmRegistry,
  evaluateTemplateDependencyAudits,
  formatTemplateDependencyAudit,
  formatTemplateDependencyAuditMarkdown,
  parseTemplateDependencyPolicy,
  TemplateDependencyPolicyError,
  templateDependencyInventory,
  templateDependencyPolicyPathParts
} from './template-dependency-security.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const auditTimeoutMs = 2 * 60_000;

function runNpmAudit(entry) {
  return new Promise((resolve) => {
    const child = spawn('npm', [
      'audit',
      '--package-lock-only',
      '--ignore-scripts',
      '--json',
      `--registry=${canonicalNpmRegistry}`
    ], {
      cwd: entry.directory,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let errorMessage;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, auditTimeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      errorMessage = error.message;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({
        status,
        stdout,
        stderr,
        timedOut,
        ...(errorMessage ? { errorMessage } : {})
      });
    });
  });
}

async function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, markdown, 'utf8');
  }
}

try {
  const policySource = await readFile(
    path.join(repositoryRoot, ...templateDependencyPolicyPathParts),
    'utf8'
  );
  const policy = parseTemplateDependencyPolicy(
    policySource,
    templateDependencyInventory
  );
  const auditResults = await auditTemplateDependencyInventory({
    repositoryRoot,
    inventory: templateDependencyInventory,
    runAudit: runNpmAudit
  });
  const result = evaluateTemplateDependencyAudits({ auditResults, policy });
  const output = formatTemplateDependencyAudit(result);
  process.stdout.write(output);
  await writeStepSummary(formatTemplateDependencyAuditMarkdown(result));
  if (!result.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const policyFailure = error instanceof TemplateDependencyPolicyError;
  const failureKind = policyFailure ? 'policy failure' : 'infrastructure failure';
  const summaryStatus = policyFailure ? 'POLICY FAILURE' : 'INFRASTRUCTURE FAILURE';
  process.stderr.write(`Template dependency audit ${failureKind}: ${message}\n`);
  await writeStepSummary(
    `## Template dependency audit: ${summaryStatus}\n\n${message}\n`
  );
  process.exitCode = 1;
}
