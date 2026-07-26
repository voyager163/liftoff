# Liftoff OpenTofu state bootstrap

This isolated OpenTofu root creates the protected remote-state boundary used by
the production telemetry root. It uses local bootstrap state intentionally so
it can create the remote backend without Azure CLI resource creation.

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
