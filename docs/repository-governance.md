# Repository governance handoff

Repository governance is a common Liftoff project choice. The default
`single-maintainer-gitflow` profile generates a deterministic local handoff;
`none` opts out:

**Local handoff generated; live enforcement is not active.**

```bash
liftoff plan --governance single-maintainer-gitflow
liftoff init --governance none
```

Accepting the default or passing `--yes` authorizes only local project files. It
does not run an agent, mutate Git, contact GitHub, configure security, install a
ruleset, deploy, or create monitoring.

## Generated files

An enabled profile adds durable, hash-managed artifacts:

```text
.liftoff/governance/policy.md
.liftoff/governance/context.json
.liftoff/governance/README.md
.github/prompts/liftoff-repository-governance.prompt.md  # Copilot selected
.claude/commands/liftoff-repository-governance.md        # Claude selected
```

The complete canonical policy is also packaged with Liftoff at
[`assets/governance/single-maintainer-gitflow/policy.md`](../assets/governance/single-maintainer-gitflow/policy.md).
It covers GitFlow, zero-human-approval repository rules, designated security
tools, fail-closed checks, immutable release evidence, build-once promotion,
deployment and rollback, monitoring and health, DORA metrics, ruleset
sequencing, negative tests, documentation, and workload adaptation.

`context.json` contains generated project facts only. GitHub repository state,
runner access, licensed features, deployments, monitoring, alert routes,
traffic, and rollout capabilities remain `undiscovered`. Power Apps context
explicitly marks Liftoff backend, Docker, OpenTofu, custom container promotion,
and API DAST as inapplicable.

## Activate after commit and push

1. Review the policy and context.
2. Commit the project and push it to the intended GitHub repository.
3. Run `/liftoff-repository-governance` with a selected agent.
4. The agent performs read-only Phase 0 and reports repository identity,
   artifacts, working commands, refs, workflows and exact checks, rulesets,
   releases, environments, security, runners, deployments, monitoring, alerts,
   health depth, platform capabilities, gaps, and inapplicable controls.
5. The agent proposes the current `main` SHA as the activation baseline,
   presents an ordered plan, and stops.
6. Explicitly approve or revise the conversational plan. This is not a human
   merge or deployment approval gate.
7. After approval, the agent creates a new OpenSpec or Spec Kit governance
   change, proves required contexts green and deliberately red, applies
   repository-scoped rulesets last, and reads live enforcement back.

The user-owned `governance/activation-baseline.json` is created only after
approval. Liftoff never owns or recreates it or the agent-created governance
change. Complete local handoffs say `handoff-generated`, partial adoptions say
`handoff-partial`, and neither state means `active`.

## Existing projects

Configurations without `governanceProfile` normalize to the enabled default
without rewriting `liftoff.config.json`:

```bash
liftoff update --check
liftoff update
```

Check mode previews the schema-v5 manifest and new named artifacts without
writing. Plain update applies collision-free files; differing existing files
remain conflicts unless individually reviewed with `--force`. An unrecorded
conflict remains outside Liftoff ownership and produces `handoff-partial`.
After every conflict is removed or matches the current artifact, the next
update records the full artifact set as `handoff-generated`.

Setting `"governanceProfile": "none"` stops future rendering. Previously managed
handoff files are reported once as orphans and left on disk; Liftoff never
deletes them automatically or changes live repository settings.

## Capability gaps

Phase 0 must report missing GitHub licenses, private runners, staging access,
monitoring routes, parallel-version mechanisms, or statistically meaningful
canary traffic. It must mark controls inapplicable or blocked rather than
creating a skipped, hanging, duplicate, or success-shaped placeholder.
