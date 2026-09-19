// Computed from the immutable pre-v2 graph whose digest is
// b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7.
export const historicalV1PhaseContractDigests = Object.freeze({
  'seed-valid': 'b95f64d271c8a4ec9cc4310d09d2aaf5cd75f358da3f567bbb7f4861baa19ce5',
  'seed-verified': '9de278215c4b8eb7735d720930bccebc2bf318ab6653f782318347001e0bf896',
  'seed-archived': '98914b387cb751cee40caa4c4990e875b61ee1c56b73cb8f77d45dbf9e1442f9',
  committed: '3b730de92254aa0e6d669fca5c8365dc0e6a2fefc6cd3d4630ca7d585dfa7714',
  pushed: '7a1d480c7853eaf0808f7eab55876870b960663911b50cadb22081016b7f46da',
  'phase-0-complete': '5721f7a3a4ad98c9b28cfd45bdb763bf589c36b468c1f2da94a9185f73821764',
  'activation-approved': 'f7cc5bcde25e4d69f786fe144e5660eee2cbc8b019893433c0aa7dcc81662410',
  'credential-ready': 'd1ac5aaafe86e703367baf18529042463c672c5ae1ec276803c3928edaf1fc9e',
  'provider-ready': '08526933f342bedc2dffeff494251eccc7178d3b917dafe475d789817130506f',
  'state-path-selected': 'd2fa833572f494dec7b8deb9e1b2ef6acebd5596603ed51d043c827af66de8e0',
  'existing-private-path': '347051fee6f2b950832062654cd4bc49faa075c55808305e9507dfb529a0ea37',
  'bootstrap-local': '265b53d1770cbca0012456b0353b363f5f13197e3e83eb9b91935db35e74e5b3',
  'runner-ready': '8fec3490808fe80cb100c21a7eaba0cc047fa9e1d8c965caacd28105e0d01fcc',
  'private-backend-proof': '4df3b33b8e47a8d35633991e737f8c945ef518f8caba2b766883aac9154ccff0',
  'remote-import-verified': 'dff8d2a749f540cbed311ee2b817d1b1b459250afec368cdce283be5fe1eeb5c',
  'remote-ready': 'ec8596fc5147069033a09709446cf313796261de09f23bc36e2d797ffd1311a6',
  'application-foundation': '293e8501552362c8b11750e1a44a11b0c129039ccf5813dde0858e2b6ae9f5a9',
  'workflow-source-ready': '2af493bee8869867913fa1f9be941420af3702984922ae7a5144e89cd345ff20',
  'dev-proof': '07182b444a6db6450012328afae748afc76c4431427ed75e8b33209f59554ac7',
  'staging-qualified': 'dda142bc0258493890c32596bf1699e3bf27723fe9346c24a3357bd66b548419',
  'production-rehearsed': '73799e977371399fff2b59e24f33fa6b197ffab520372cadfc6336832d9402ed',
  'green-red-proof': '2dbe838df1dc444739483b0a514696b0ee507cae9be64c7b5e97d93e41f845a7',
  'enforcement-approved': 'c8684a13d3ee3dd0015b61c1e5f027d16d9f7b8079ade0e7b139ad5443fe1f8b',
  'rulesets-applied': '70766619e52f7cd6f3b9ace1277526aefa598d4d10863c4563ca56636ffa46c2',
  'live-readback': '6c1435989878f198d6c9c2ec742d10381bd320109e7d7fc1994ef647abb80ebe',
  'bootstrap-state-disposed': 'b4a2bdcbd1e253f0e4c6debf24af7f0495e9318a2e7d9d98d00e0c641266089c'
});

export function historicalV1ResultAllowed(phaseId: keyof typeof historicalV1PhaseContractDigests, result: string): boolean {
  if (phaseId === 'activation-approved' || phaseId === 'enforcement-approved') return result === 'failed';
  if (phaseId === 'bootstrap-state-disposed') return ['disposed', 'failed', 'inapplicable'].includes(result);
  if (phaseId === 'provider-ready' || phaseId === 'remote-ready') return ['verified', 'failed', 'inapplicable', 'retained'].includes(result);
  if ([
    'credential-ready', 'state-path-selected', 'existing-private-path', 'bootstrap-local',
    'runner-ready', 'private-backend-proof', 'remote-import-verified'
  ].includes(phaseId)) return ['verified', 'failed', 'inapplicable'].includes(result);
  return result === 'verified' || result === 'failed';
}

export const historicalPhaseIds = Object.keys(historicalV1PhaseContractDigests) as readonly (keyof typeof historicalV1PhaseContractDigests)[];
export type HistoricalPhaseId = (typeof historicalPhaseIds)[number];
