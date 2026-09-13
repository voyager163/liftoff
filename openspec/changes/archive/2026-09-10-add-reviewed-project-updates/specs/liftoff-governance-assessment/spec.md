## MODIFIED Requirements

### Requirement: Unsupported activation identities remain diagnosable without unsafe parsing
Assessment SHALL retain safe found-versus-target diagnosis for supported manifests with unsupported activation identities. Original known v1 records SHALL remain diagnostic-only and SHALL not be migrated, deleted, or accepted as current proof by assessment. A declared supported successor lane SHALL be explained through the human-first update-check remedy. In an already migrated project, assessment SHALL distinguish the validated retained snapshot from the active v2 successor and evaluate only independently interpretable current facts. Unknown formats, unsafe paths, malformed active records, and broken declared migration links SHALL not trigger permissive fallback or relaxed mutation compatibility.

#### Scenario: Activation policy or graph is unsupported
- **WHEN** the recorded tuple cannot execute under the installed engine
- **THEN** assessment reports the difference and assesses only independently interpretable facts
- **AND** evidence-dependent unknowns remain not-observed without an invented mapping

#### Scenario: Historical activation v1 is present
- **WHEN** known v1 is still the active historical representation
- **THEN** assessment reports diagnostic-only status and actual migration eligibility
- **AND** it recommends `liftoff update --check` only when relevant without creating a receipt, approval, or successor

#### Scenario: Manifest structure is unknown or malformed
- **WHEN** the manifest cannot be safely interpreted
- **THEN** assessment emits safe diagnostics without accessing artifact paths from the unsupported structure

#### Scenario: Path attempts to escape the project
- **WHEN** an artifact or migration-history reference contains traversal, embedded separators, drive/UNC parts, or an unsafe link
- **THEN** assessment refuses access under the same Windows, macOS, and Linux boundary rules

#### Scenario: Current proof coexists with preserved v1
- **WHEN** a valid migration link connects retained v1 history to current v2 state
- **THEN** assessment reports history separately and uses only validated current proof for present readiness and scope
- **AND** historical presence alone does not make current evidence unsupported

#### Scenario: Migration has incomplete revalidation
- **WHEN** the local migration committed but current proof is incomplete
- **THEN** assessment reports the actual coverage gaps without treating migration completion as alignment
- **AND** it does not run revalidation, refresh a preview, or authorize a later transition
