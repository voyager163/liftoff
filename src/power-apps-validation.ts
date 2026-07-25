import { readFile } from 'node:fs/promises';
import path from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function verifyPowerAppsPackageMetadata(projectRoot: string): Promise<string[]> {
  const packagePath = path.join(projectRoot, 'package.json');
  const lockPath = path.join(projectRoot, 'package-lock.json');
  let packageJson: unknown;
  let lockJson: unknown;
  try {
    [packageJson, lockJson] = await Promise.all([
      readFile(packagePath, 'utf8').then((content) => JSON.parse(content) as unknown),
      readFile(lockPath, 'utf8').then((content) => JSON.parse(content) as unknown)
    ]);
  } catch (error) {
    return [`Unable to read Power Apps package metadata: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (!isRecord(packageJson)) {
    return ['package.json must be a JSON object.'];
  }
  if (!isRecord(lockJson)) {
    return ['package-lock.json must be a JSON object.'];
  }

  const dependencies = packageJson.dependencies;
  const devDependencies = packageJson.devDependencies;
  const issues: string[] = [];
  const sdkRange = isRecord(dependencies) ? dependencies['@microsoft/power-apps'] : undefined;
  const viteRange = isRecord(devDependencies) ? devDependencies['@microsoft/power-apps-vite'] : undefined;
  if (typeof sdkRange !== 'string') {
    issues.push('package.json must declare @microsoft/power-apps.');
  }
  if (typeof viteRange !== 'string') {
    issues.push('package.json must declare @microsoft/power-apps-vite.');
  }

  const packages = isRecord(lockJson.packages) ? lockJson.packages : undefined;
  const lockRoot = packages && isRecord(packages['']) ? packages[''] : undefined;
  const lockedDependencies = lockRoot && isRecord(lockRoot.dependencies) ? lockRoot.dependencies : undefined;
  const lockedDevDependencies = lockRoot && isRecord(lockRoot.devDependencies) ? lockRoot.devDependencies : undefined;
  if (
    typeof packageJson.name !== 'string' ||
    packageJson.name.length === 0 ||
    lockJson.name !== packageJson.name ||
    lockRoot?.name !== packageJson.name
  ) {
    issues.push('package.json and package-lock.json must record the same project name.');
  }
  if (typeof sdkRange === 'string' && lockedDependencies?.['@microsoft/power-apps'] !== sdkRange) {
    issues.push('package-lock.json must lock the declared @microsoft/power-apps range.');
  }
  if (typeof viteRange === 'string' && lockedDevDependencies?.['@microsoft/power-apps-vite'] !== viteRange) {
    issues.push('package-lock.json must lock the declared @microsoft/power-apps-vite range.');
  }

  const sdkPackage = packages && isRecord(packages['node_modules/@microsoft/power-apps'])
    ? packages['node_modules/@microsoft/power-apps']
    : undefined;
  const vitePackage = packages && isRecord(packages['node_modules/@microsoft/power-apps-vite'])
    ? packages['node_modules/@microsoft/power-apps-vite']
    : undefined;
  const cliPackage = packages && isRecord(packages['node_modules/@microsoft/power-apps-cli'])
    ? packages['node_modules/@microsoft/power-apps-cli']
    : undefined;
  const sdkDependencies = sdkPackage && isRecord(sdkPackage.dependencies)
    ? sdkPackage.dependencies
    : undefined;
  const cliBin = cliPackage && isRecord(cliPackage.bin) ? cliPackage.bin : undefined;
  if (!sdkPackage || typeof sdkPackage.version !== 'string') {
    issues.push('package-lock.json must include the @microsoft/power-apps package.');
  }
  if (!vitePackage || typeof vitePackage.version !== 'string') {
    issues.push('package-lock.json must include the @microsoft/power-apps-vite package.');
  }
  if (
    typeof sdkDependencies?.['@microsoft/power-apps-cli'] !== 'string' ||
    typeof cliPackage?.version !== 'string' ||
    typeof cliBin?.['power-apps'] !== 'string'
  ) {
    issues.push('package-lock.json must include the project-local power-apps CLI declaration.');
  }
  return issues;
}
