## Context

See `proposal.md` for motivation. Deployment environments are persisted in
desired state and manifests, used in provisioning-group and logical-name
identities, rendered into runtime directories and OpenTofu filenames, and shown
in CLI help and prompts. The user explicitly chose removal rather than a
compatibility alias for `test`.

## Goals / Non-Goals

**Goals:**

- Use one canonical environment set: `dev`, `staging`, `prod`.
- Reject `test` consistently before generation or helper output.
- Keep deployment environment paths deterministic and cross-platform.
- Preserve software test commands, test directories, and test framework names.
- Provide an actionable manual migration remedy for existing project-owned
  `test` files.

**Non-Goals:**

- Automatically rename existing project-owned environment directories or
  OpenTofu files.
- Mutate live cloud environments or deployed resources.
- Alias `test` to `staging` in manifests, configuration, or commands.
- Change manifest JSON structure or the activation-contract version vector.

## Decisions

### Replace the identifier at the catalog boundary

`EnvironmentId` and the environment catalog contain exactly `dev`, `staging`,
and `prod`. All defaults derive from a shared ordered constant. This prevents
prompts, help, planning, and generated output from drifting independently.

An alias was rejected because it would continue accepting and generating an
environment name the user explicitly retired.

### Reject rather than silently migrate

Configuration, manifests, and `liftoff infra --env` validate through the
catalog. `test` therefore fails with supported values instead of silently
targeting `staging`. Existing project-owned `environments/test` and
`test.tfvars` files are not renamed by `liftoff update`; documentation requires
review before manual migration.

### Replace environment-derived artifact identity

Default rendering emits `environment-staging-*`, `opentofu-staging-tfvars`,
`environments/staging`, and `staging.tfvars`. Non-environment logical names
remain append-only. The main manifest contract explicitly records that
environment-derived identities follow the reviewed supported environment set.

### Keep path construction platform-neutral

Generated artifacts continue using path-part arrays and Node path utilities.
Tests assert staging provisioning paths and presentation on the supported
platform matrix without hardcoded host separators.

## Risks / Trade-offs

- **[Existing projects with `test` stop validating]** -> Fail with the exact
  unsupported identifier and document manual review/rename to `staging`.
- **[A broad text replacement could alter software testing]** -> Limit changes
  to deployment environment types, values, paths, and explicit fixtures; retain
  `npm test`, pytest, Go tests, `tests/`, and `backend-test` identities.
- **[Update could overwrite project-owned environment files]** -> Preserve the
  existing create-only/project-owned update boundary; no automatic rename.
- **[Snapshots can conceal accidental output changes]** -> Refresh only affected
  environment/help/lifecycle snapshots and rerun the full suite without update.

## Migration Plan

1. Replace the environment type/catalog and shared defaults.
2. Validate CLI, config, manifest, and helper inputs against the new set.
3. Regenerate current environment-derived fixtures and snapshots with staging.
4. Update main and delta specs plus migration documentation.
5. Run strict specs, full tests, package smoke, and generated-template checks.
6. Release as patch `0.10.1`; rollback by restoring the `0.10.0` catalog and
   fixtures together if an unrecoverable regression is found.
