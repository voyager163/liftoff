# Command reference

<!-- Generated from src/cli/registry.ts by scripts/render-cli-reference.ts. Do not edit. -->

Every command accepts `--json` (print one JSON report on stdout) and `--help`.

## Exit codes

| Code | Outcome |
| --- | --- |
| 0 | success |
| 1 | failure |
| 2 | usage |
| 3 | attention |
| 4 | cancelled |
| 5 | partial |
| 6 | unsupported |

## liftoff capabilities

Prints every command this installation supports, with its options, whether it is read-only and the schema of its JSON report. Coding-agent skills call this before running other commands.

Read-only.

JSON report: `liftoff.capabilities/v1`.

| Option | Description |
| --- | --- |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff capabilities --json
```

## liftoff plan

Works out every file a new project would get, who owns each one and what creating it would do, and changes nothing. With --out it saves the plan so `liftoff init --plan` can create exactly that project.

Read-only.

JSON report: `liftoff.plan-report/v1`.

| Option | Description |
| --- | --- |
| `--name <name>` | Project name: 2 to 50 lowercase letters, digits and single hyphens. |
| `--dir <path>` | Directory to create. Defaults to ./<name>. |
| `--workload <workload>` | Kind of project: an API, or a GenAI API built around one pattern. (one of `api`, `genai`; default `api`) |
| `--stack <stack>` | Technology stack: python-fastapi, node-fastify, go-huma, python-pydanticai. Defaults to python-fastapi for api and python-pydanticai for genai. |
| `--pattern <pattern>` | GenAI pattern, for genai projects: generic, prompt, chatbot, rag, agent, multi-agent, fine-tuned, streaming, workflow. Defaults to generic. (one of `none`, `generic`, `prompt`, `chatbot`, `rag`, `agent`, `multi-agent`, `fine-tuned`, `streaming`, `workflow`) |
| `--frontend <frontend>` | Web frontend, or none. (one of `none`, `vue`; default `none`) |
| `--infrastructure <provider>` | Infrastructure as code, or none. azure generates OpenTofu for Azure. (one of `none`, `azure`; default `none`) |
| `--environments <list>` | Environments to generate infrastructure for, comma-separated: dev, staging, prod. Defaults to all three with --infrastructure. |
| `--workflow <workflow>` | Development workflow: openspec, spec-kit or manual. (default `openspec`) |
| `--agents <list>` | Coding-agent hosts, comma-separated: copilot, codex, claude. Defaults to none. |
| `--governance <profile>` | Governance profile: single-maintainer-gitflow, team-gitflow, risk-tiered-gitflow, none. (default `single-maintainer-gitflow`) |
| `--ai-review <mode>` | Verified AI review in CI; auto turns it on when agents are selected. (one of `auto`, `on`, `off`; default `auto`) |
| `--review-engine <host>` | Which selected agent host runs the verified AI review. |
| `--owners <logins>` | GitHub logins that own the project, comma-separated, for CODEOWNERS. With team-gitflow, which requires an approval for every change, at least two owners also make a code owner's approval required. |
| `--out <file>` | Save the plan to this file for `liftoff init --plan`. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff plan --name demo --workflow manual
liftoff plan --name demo --workflow manual --agents copilot,claude --out demo.plan.json
```

## liftoff init

Creates a new project in a new or empty directory, from a saved plan (--plan) or from the same options as `liftoff plan`. It shows what it will create and asks before writing anything; the default answer is no. In scripts, pass --yes. Nothing is installed, run or sent anywhere: the project is written in one step, or not at all.

Changes files; asks first unless `--yes` is given.

JSON report: `liftoff.init-report/v1`.

| Option | Description |
| --- | --- |
| `--name <name>` | Project name: 2 to 50 lowercase letters, digits and single hyphens. |
| `--dir <path>` | Directory to create. Defaults to ./<name>. |
| `--workload <workload>` | Kind of project: an API, or a GenAI API built around one pattern. (one of `api`, `genai`; default `api`) |
| `--stack <stack>` | Technology stack: python-fastapi, node-fastify, go-huma, python-pydanticai. Defaults to python-fastapi for api and python-pydanticai for genai. |
| `--pattern <pattern>` | GenAI pattern, for genai projects: generic, prompt, chatbot, rag, agent, multi-agent, fine-tuned, streaming, workflow. Defaults to generic. (one of `none`, `generic`, `prompt`, `chatbot`, `rag`, `agent`, `multi-agent`, `fine-tuned`, `streaming`, `workflow`) |
| `--frontend <frontend>` | Web frontend, or none. (one of `none`, `vue`; default `none`) |
| `--infrastructure <provider>` | Infrastructure as code, or none. azure generates OpenTofu for Azure. (one of `none`, `azure`; default `none`) |
| `--environments <list>` | Environments to generate infrastructure for, comma-separated: dev, staging, prod. Defaults to all three with --infrastructure. |
| `--workflow <workflow>` | Development workflow: openspec, spec-kit or manual. (default `openspec`) |
| `--agents <list>` | Coding-agent hosts, comma-separated: copilot, codex, claude. Defaults to none. |
| `--governance <profile>` | Governance profile: single-maintainer-gitflow, team-gitflow, risk-tiered-gitflow, none. (default `single-maintainer-gitflow`) |
| `--ai-review <mode>` | Verified AI review in CI; auto turns it on when agents are selected. (one of `auto`, `on`, `off`; default `auto`) |
| `--review-engine <host>` | Which selected agent host runs the verified AI review. |
| `--owners <logins>` | GitHub logins that own the project, comma-separated, for CODEOWNERS. With team-gitflow, which requires an approval for every change, at least two owners also make a code owner's approval required. |
| `--plan <file>` | Create exactly the project in this saved plan. |
| `--yes` | Create it without asking. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff init --plan demo.plan.json
liftoff init --name demo --workflow manual --agents claude --yes
```

## liftoff validate

Checks liftoff.yaml, the plugins it names and every file in .liftoff/manifest.json. Files Liftoff manages that are missing or were changed by hand are reported; files the project owns may change freely. Nothing is repaired or changed.

Read-only.

JSON report: `liftoff.validation/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff validate
liftoff validate --dir demo --json
```

## liftoff doctor

Checks that the tools the project needs are installed and new enough, by running their version commands. Inside a Liftoff project it checks that project's stack; elsewhere, the tools every project needs. Nothing is installed or changed.

Read-only.

JSON report: `liftoff.doctor/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff doctor
liftoff doctor --dir demo --json
```

## liftoff review classify

Classifies the change on this branch against its base with the repository's review policy (.github/review-policy.yml, read from the base branch). Reports the risk tier, review depth, required human approvals and why. It is the same check CI runs, so the result predicts what the pull request will need.

Read-only.

JSON report: `liftoff.review-classification/v1`.

| Option | Description |
| --- | --- |
| `--base <branch>` | Branch the change will merge into. (default `develop`) |
| `--author <login>` | GitHub login of the author. Without it, a trusted author is assumed. |
| `--committed` | Only count committed changes, not the working tree. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff review classify
liftoff review classify --base main --json
liftoff review classify --author octocat --committed
```
