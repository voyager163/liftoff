## Why

Liftoff currently presents `dev,test,prod`, while the governed delivery flow and
repository policy use Staging as the pre-production qualification environment.
Using `staging` consistently removes that naming mismatch from CLI input,
generated configuration, infrastructure, and documentation.

## What Changes

- Replace the supported deployment environment set with `dev`, `staging`, and
  `prod`, in that order.
- Make interactive and non-interactive defaults use `dev,staging,prod`.
- Generate `environments/staging`, `staging.tfvars`, staging provisioning groups,
  and staging-derived logical names instead of their `test` equivalents.
- Reject `test` in CLI helper input, desired-state configuration, and manifests
  with a supported-environment remedy.
- **BREAKING** Retire the `test` deployment environment identifier without a
  compatibility alias. Existing projects must review and rename `test`
  configuration and project-owned environment files to `staging`.
- Update public documentation, main specifications, fixtures, contract tests,
  and presentation snapshots.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `liftoff-cli-workflow`: Default environment capture and infrastructure helper
  validation use only `dev`, `staging`, and `prod`.
- `liftoff-infrastructure-governance`: Generated OpenTofu environment
  configuration uses `staging.tfvars` instead of `test.tfvars`.
- `liftoff-project-scaffold`: Generated runtime and worker configuration uses
  `dev`, `staging`, and `prod`.
- `liftoff-manifest-contract`: Current manifests, configuration, and
  environment-derived logical names retire `test` and accept only the new set.

## Impact

This changes environment catalog types, CLI defaults and helper validation,
planner behavior, generated manifest/configuration paths and logical names,
OpenTofu tfvars, current OpenSpec contracts, user documentation, historical
manifest fixtures used by tests, and terminal snapshots. It changes no
application test commands, test directories, testing frameworks, or live cloud
resources.
