# Liftoff OpenTofu state bootstrap

This isolated OpenTofu root creates the protected remote-state boundary used by
the production telemetry root. It uses local bootstrap state intentionally so
it can create the remote backend without Azure CLI resource creation.

## Scope and current availability

This is the repository maintainer's telemetry bootstrap root. It is not a
generated customer-project root, a public brownfield migration command, or proof
that an arbitrary workstation can hold protected bootstrap state.

The repository can validate these files without backend or Azure access:

```bash
tofu -chdir=infrastructure/opentofu/bootstrap fmt -check
tofu -chdir=infrastructure/opentofu/bootstrap init -backend=false
tofu -chdir=infrastructure/opentofu/bootstrap validate
```

The live plan/apply example below is an operator runbook only. It requires an
already reviewed Azure scope, current cost and permission approval, an admitted
operator network path, and a host that independently satisfies the protected
storage, non-exporting key, locking, writer-quiescence, backup, retention, and
due-time disposal contract.

New-environment activation has one narrow exception: backend resources created
by the same recorded operation may be handed over by that operation after exact
ownership and no-change readback. The engine contracts, proof validation, and
injected handover/custody ports exist, but the default public CLI does not
register production implementations of those ports. That is an implementation
and qualification gap, not an approval prompt; operator consent cannot turn an
absent adapter into an available capability.

Pre-existing deployment/state adoption, import, partition, relocation, and
address migration remain planning-only. Missing local state is never evidence
that the Azure scope is absent or newly owned.

It also owns the enforced Azure Network Security Perimeter profile that protects
state storage. Explicit operator IPv4 `/32` CIDRs are the target architecture's
only inbound exceptions. Storage keys remain disabled; perimeter admission does
not replace Entra authentication or resource-scoped RBAC.

The bootstrap uses the ARM control plane for the storage account and container,
so provider refresh does not materialize storage keys in state. The local state
still contains subscription, tenant, object, and resource metadata. Treat it as
sensitive, keep it private, and back it up to approved encrypted storage for
future backend maintenance.

```bash
tofu -chdir=infrastructure/opentofu/bootstrap init
tofu -chdir=infrastructure/opentofu/bootstrap plan \
  -var-file=../../../.azure/telemetry-bootstrap.tfvars \
  -out=../../../.azure/telemetry-bootstrap.tfplan
tofu -chdir=infrastructure/opentofu/bootstrap apply \
  ../../../.azure/telemetry-bootstrap.tfplan
tofu -chdir=infrastructure/opentofu/bootstrap state pull \
  > /secure/encrypted/liftoff-bootstrap.tfstate
```

The apply creates:

- protected `rg-liftoff-tfstate`;
- `stliftofftfstatef5be1618` through AzAPI with shared keys disabled, blob
  versioning, infrastructure encryption, and 30-day delete retention;
- private `tfstate` container through the ARM control plane; and
- protected NSP, profile, operator-CIDR rule, and enforced state-storage
  association; and
- storage-account-scoped Blob Data Contributor for the deploying principal.

The role propagation gate waits before the apply completes. Production may then
initialize with `.azure/telemetry-backend.hcl`.

## Operator CIDR recovery

Keep `operator_cidrs` only in ignored `.azure/telemetry-bootstrap.tfvars`.
Every value must be an IPv4 `/32`. If your public address changes and the
backend becomes unreachable:

1. Determine the new public address through an approved trusted source.
2. Update the ignored `operator_cidrs` value.
3. Run a bootstrap `tofu plan` and inspect that only the operator access rule
   changes.
4. Apply that plan through the Azure control plane.
5. Retry remote backend access only after Azure reports the rule succeeded.

Do not add dynamic GitHub-hosted runner ranges. Standard hosted CI performs only
build, test, formatting, backend-free initialization, and validation.

## Grafana does not own the state boundary

The telemetry [Grafana runbook](../telemetry/README.md#managed-grafana-deployment-and-remaining-qualification)
adds separate resource and dashboard roots, not another bootstrap or a state
migration. The authorized 2026-10-18 rollout used distinct keys
`telemetry/production.tfstate`, `grafana/production.tfstate` and
`grafana/dashboards-production.tfstate` in the existing private container,
preserving the telemetry lineage and perimeter. Dashboard removal/restoration
and project-feature disablement were exercised without destroying these
resources or accepted telemetry. This operator evidence does not qualify
application whole-job custody or public deployment-state commands.

Future approved roots need distinct keys in the existing private
`tfstate` container and independently verified ownership/lineage, writer
locking, protected host and network admission. Do not reuse the telemetry key,
copy state, broaden either storage network layer, change the enforced
`state-storage` association or give Grafana's query identity state access.
Dashboard disablement/rollback preserves this group, account, container,
perimeter and all accepted telemetry records.

The commands above are an operator runbook, not authority to provision, read
state payloads or change CIDRs. Source preparation and backend-free validation
do not qualify production custody, network admission or rollback. Existing
resources are in Korea Central; examples/defaults are never authority for
replacement. Repository checks need no production credentials:

```bash
tofu -chdir=infrastructure/opentofu/bootstrap fmt -check
tofu -chdir=infrastructure/opentofu/bootstrap init -backend=false -input=false -lockfile=readonly
tofu -chdir=infrastructure/opentofu/bootstrap validate
```
