import { DistributionError } from '../../domain/distribution/errors.js';
import type { NativeAdmission } from '../../adapters/distribution/native-admission.js';
import type { InstallationDetector } from '../../adapters/distribution/installation-detector.js';
import type { NativeManagerSelection, NativeOwnerAdapter } from '../../adapters/distribution/owner-adapter.js';
import { observePathLaunchers } from '../../adapters/distribution/launcher-observation.js';

export async function verifyManagerReplacement(
  admission: NativeAdmission, detector: InstallationDetector, manager: NativeOwnerAdapter,
  selection: NativeManagerSelection, provenanceDigest: string
): Promise<void> {
  const candidate = await admission.admitBundle(selection.destinationDirectory);
  if (candidate.provenanceDigest !== provenanceDigest || candidate.version !== selection.version) {
    throw new DistributionError('Manager installed a different native target.', 'verification_failed');
  }
  await manager.verify(candidate, selection);
  await admission.probe(candidate);
  await admission.probeLinkedLauncher(candidate, selection.launcherPath);
  const ordinary = (await observePathLaunchers(detector.env, detector.cwd))[0];
  if (ordinary?.path !== selection.launcherPath || ordinary.state !== 'link') {
    throw new DistributionError('Ordinary command resolution selects a different installation than the verified replacement.', 'verification_failed');
  }
  await admission.probeLinkedLauncher(candidate, ordinary.path);
  await manager.verify(candidate, selection);
}
