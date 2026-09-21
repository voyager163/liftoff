import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  createGoToolGraphContract, goToolContractGraph, parseGoToolGraphContract, requireGoToolContractObservation
} from '../scripts/repository-security/osv-go-contract.ts';
import { osvDigest, type OsvGraph } from '../scripts/repository-security/osv.ts';

const name = 'github.com/pressly/goose/v3', version = 'v3.27.3', sum = `h1:${'a'.repeat(43)}=`;
const selected: OsvGraph = {
  id: 'go-backend', pathParts: ['assets', 'supported-stack.json'], inputDigest: osvDigest('simulated graph'),
  components: [{ name, version, ecosystem: 'Go', chains: [['go-backend/tool', name]] }]
};
const row = { name, version, sum, goModSum: sum };
const source = `123\n${name} ${version} ${sum}\n${name} ${version}/go.mod ${sum}\n\ngo.sum database tree\n1\nfixture\n\n— sum.golang.org nonfunctional-signature\n`;
function fixture() {
  return createGoToolGraphContract({
    expectedVersion: version, selected, upstreamGoSum: '', exactSums: [row],
    records: [{ name, version, record: source, recordDigest: osvDigest(source) }],
    root: { ...row, archiveDigest: osvDigest('zip'), goModDigest: osvDigest('mod'), upstreamGoSumDigest: osvDigest('') },
    derivation: { method: 'frozen-go-list-m-all', goVersion: '1.27.1', goExecutableDigest: osvDigest('tool'),
      rootGoVersion: '1.25.7', moduleGraphDigest: osvDigest('edges'), selectedGraphDigest: selected.inputDigest,
      observedAt: '2026-09-20T10:00:00.000Z', proxy: 'https://proxy.golang.org', sumdb: 'sum.golang.org',
      toolchain: 'local', metadata: 'readonly' }
  });
}

describe('goose source checksum contract structure (simulated signature fixtures)', () => {
  it('retains exact rows, baseline lookup, observed provenance and actual graph paths', () => {
    const contract = fixture();
    expect(contract.modules).toHaveLength(1);
    expect(contract.baseline.lookup).toEqual(['goModules', 'go-backend', 'tools', name]);
    expect(contract.modules[0]!.provenance.sum).toBe('go-verified-sumdb-cache');
    expect(goToolContractGraph(contract).components).toEqual(selected.components);
    expect(() => requireGoToolContractObservation(contract, selected, [row], '')).not.toThrow();
    expect(JSON.stringify(contract)).not.toContain('"approved"');
  });

  describe('retained release-owned goose inventory', () => {
    it('has exact checksum pairs and retained derivation evidence for every selected module', async () => {
      const baseline = JSON.parse(await readFile('assets/supported-stack.json', 'utf8'));
      const contract = parseGoToolGraphContract(await readFile('security/go-tool-graphs.json', 'utf8'),
        baseline.goModules['go-backend'].tools[name]);
      expect(contract.modules).toHaveLength(205);
      expect(contract.sumdbRecords).toHaveLength(87);
      expect(contract.modules.filter(module => module.provenance.sum === 'go-verified-sumdb-cache')).toHaveLength(87);
      expect(contract.modules.filter(module => module.provenance.goModSum === 'go-verified-sumdb-cache')).toHaveLength(67);
      expect(contract.root.sum).toBe('h1:pIglVHjw99r4e/hDHHwbl9vfOsDMqUokfkXo6+n/RxA=');
      expect(contract.root.goModSum).toBe('h1:Dag+xpV6o20HR2LFY1j0q6MDwc3f7vPUFDA77R+0yGY=');
      expect(contract.derivation.selectedGraphDigest).toBe('sha256:4f5461eba33fdde9622f893fcdf331d5298f769677b828881252c3b71567994f');
      expect(new Set(contract.modules.map(module => module.name)).size).toBe(205);
    });
  });

  it('rejects missing, duplicate, wrong-version, approval and waiver data', () => {
    const contract = fixture();
    for (const change of [
      { modules: [] }, { modules: [...contract.modules, ...contract.modules] },
      { approved: true }, { waiver: 'permit-unknown-severity' }, { sumdbRecords: [] }
    ]) expect(() => parseGoToolGraphContract(JSON.stringify({ ...contract, ...change }), version)).toThrow();
    expect(() => parseGoToolGraphContract(JSON.stringify(contract), 'v3.28.0')).toThrow();
  });

  it('never counts a digest or count as an exact fresh observation', () => {
    const contract = fixture();
    expect(() => requireGoToolContractObservation(contract, selected, [])).toThrow();
    expect(() => requireGoToolContractObservation(contract, { ...selected, components: [] }, [row])).toThrow();
    expect(() => requireGoToolContractObservation(contract, selected, [{ ...row, sum: `h1:${'b'.repeat(43)}=` }])).toThrow();
    const differentChain = structuredClone(selected);
    differentChain.components[0]!.chains = [['different', name]];
    expect(() => requireGoToolContractObservation(contract, differentChain, [row])).toThrow();
  });

  it('binds retained sumdb record bytes and rejects false upstream provenance', () => {
    const changed = fixture();
    changed.sumdbRecords[0]!.record += 'NONFUNCTIONAL_CONTRACT_SENTINEL';
    expect(() => parseGoToolGraphContract(JSON.stringify(changed), version)).toThrow('osv-invalid-tool-graph-contract');
    const contract = fixture();
    expect(() => requireGoToolContractObservation(contract, selected, [row], `${name} ${version} ${sum}\n`)).toThrow();
    expect(() => parseGoToolGraphContract('NONFUNCTIONAL_CONTRACT_SENTINEL', version)).toThrow('osv-invalid-tool-graph-contract');
  });
});
