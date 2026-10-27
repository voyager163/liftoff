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

Creates a new project in a new or empty directory, from a saved plan (--plan) or from the same options as `liftoff plan`. Run in a terminal without options, it asks for each option in turn and shows the command that gives the same answers. It shows what it will create and asks before writing anything; the default answer is no. In scripts, pass --yes. The project is written in one step, or not at all. With the OpenSpec or Spec Kit workflow, init also runs that framework's own initializer at a pinned version, which downloads it; nothing else is installed, run or sent anywhere.

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
liftoff init
liftoff init --plan demo.plan.json
liftoff init --name demo --workflow manual --agents claude --yes
```

## liftoff validate

Checks liftoff.yaml, the plugins it names and every file in .liftoff/manifest.json. Files Liftoff manages that are missing or were changed by hand are reported; files the project owns may change freely. In a project made by a Liftoff release before the rebuild, it reports what that release left and whether each record can be carried over. Nothing is repaired, changed or run.

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

## liftoff assess

Walks the project, within limits and without following links, and checks its applications, dependencies, tests, builds, database, coding-agent setup, CI, governance, infrastructure and documentation against what this Liftoff release generates. It reads only the declarations it interprets, such as pyproject.toml, package.json and workflow files, never secrets or state, runs nothing and writes nothing. Each finding is compliant, noncompliant, unknown, unsupported or inaccessible, with the paths it rests on, and what was not walked or read is listed. With --live it also reads the repository's governance on GitHub, after you agree.

Read-only.

JSON report: `liftoff.assessment/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Directory to assess: the root of a Git repository, or any other directory when named. (default `.`) |
| `--live` | Also read the repository's branches, rulesets and check runs on GitHub. |
| `--repo <owner/name>` | With --live, the GitHub repository. Defaults to the one origin points at. |
| `--use-gh` | With --live, let Liftoff use your GitHub CLI login without asking. Liftoff never sees or stores your credentials. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff assess
liftoff assess --dir ../service --json
liftoff assess --live --use-gh
```

## liftoff adopt

Reads the project as liftoff assess does, running nothing, and proposes what it is: its backend's stack, a frontend and infrastructure, each where it lives, the coding-agent hosts it is set up for and, for a project from a Liftoff release before the rebuild, what its old configuration says. Options replace any part of the proposal. Adopting adds liftoff.yaml, .liftoff/manifest.json and Liftoff's own workflows, review policy, governance handoff, skills and instructions, made for where the parts live, and changes no file the project has: where one of Liftoff's files would go, the project's own is kept. It never replaces the application with a starter; a part it cannot place blocks adopting, with why. It lists the application changes the standard expects, which it does not make. It shows the plan and asks before changing anything; the default answer is no. In scripts, pass --yes. An adoption that stops part way can be finished or undone with --recover.

Changes files; asks first unless `--yes` is given.

JSON report: `liftoff.adopt/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. Without it, the current directory must be the root of a Git repository. (default `.`) |
| `--name <name>` | Project name: 2 to 50 lowercase letters, digits and single hyphens. Defaults to the old configuration's, or the directory's name. |
| `--stack <stack>` | The backend's stack, when the project holds more than one kind. (one of `python-fastapi`, `node-fastify`, `go-huma`, `python-pydanticai`) |
| `--pattern <pattern>` | GenAI pattern, for a PydanticAI backend. Defaults to generic. (one of `generic`, `prompt`, `chatbot`, `rag`, `agent`, `multi-agent`, `fine-tuned`, `streaming`, `workflow`) |
| `--frontend <frontend>` | Web frontend, or none to leave one found as the project's own. (one of `none`, `vue`) |
| `--infrastructure <provider>` | Infrastructure as code, or none to leave any found as the project's own. (one of `none`, `azure`) |
| `--environments <list>` | Environments the infrastructure deploys to, comma-separated: dev, staging, prod. Defaults to all three. |
| `--agents <list>` | Coding-agent hosts, comma-separated: copilot, codex, claude. Defaults to those the project is set up for. |
| `--governance <profile>` | Governance profile. Defaults to single-maintainer-gitflow. (one of `single-maintainer-gitflow`, `team-gitflow`, `risk-tiered-gitflow`, `none`) |
| `--ai-review <mode>` | Verified AI review in CI; auto turns it on when agents are selected. (one of `auto`, `on`, `off`) |
| `--review-engine <host>` | Which selected agent host runs the verified AI review. |
| `--owners <logins>` | GitHub logins that own the project, comma-separated, for CODEOWNERS. |
| `--layout <bindings>` | Where each part lives, as part=directory pairs, comma-separated, such as backend=services/api,frontend=web; . is the repository root. |
| `--check` | Change nothing; show what adopting would do, and exit 3 when the project cannot be adopted as it is. |
| `--out <file>` | Save the plan to this file and change nothing in the project; apply it with --plan. |
| `--plan <file>` | Apply exactly this saved plan, and refuse it if the project or Liftoff changed since. |
| `--recover <mode>` | Finish or undo an adoption that stopped part way. (one of `finish`, `undo`) |
| `--yes` | Change the files without asking. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff adopt --check
liftoff adopt --dir ../service --layout backend=api,frontend=web --agents claude
liftoff adopt --out adopt.plan.json
liftoff adopt --plan adopt.plan.json --yes
liftoff adopt --recover undo
```

## liftoff migrate

Reads the project as liftoff assess does, running nothing, and proposes the new project from what it finds, as liftoff adopt does; options replace any part of the proposal. In a new or empty directory beside it, it makes the project liftoff init would make, starter application included, with a copy of the old project's files in legacy/ and MIGRATION.md, a checklist of what to move and how to check it. The copy leaves out Git's data, installed dependencies, caches, build output, files that may hold secrets or state, and records from a Liftoff release before the rebuild, and names each. The old project is never changed. It shows the plan and asks before creating anything; the default answer is no. In scripts, pass --yes.

Changes files; asks first unless `--yes` is given.

JSON report: `liftoff.migrate/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | The project to migrate. Without it, the current directory must be the root of a Git repository. (default `.`) |
| `--to <path>` | A new or empty directory for the new project. Defaults to the project's directory name followed by -liftoff, beside it. |
| `--name <name>` | Project name: 2 to 50 lowercase letters, digits and single hyphens. Defaults to the old configuration's, or the directory's name. |
| `--stack <stack>` | The new project's backend stack. Defaults to the stack of the backend the project holds; name one to move the application to it. (one of `python-fastapi`, `node-fastify`, `go-huma`, `python-pydanticai`) |
| `--pattern <pattern>` | GenAI pattern, for a PydanticAI backend. Defaults to generic. (one of `generic`, `prompt`, `chatbot`, `rag`, `agent`, `multi-agent`, `fine-tuned`, `streaming`, `workflow`) |
| `--frontend <frontend>` | Web frontend, or none to leave one found as the project's own. (one of `none`, `vue`) |
| `--infrastructure <provider>` | Infrastructure as code, or none to leave any found as the project's own. (one of `none`, `azure`) |
| `--environments <list>` | Environments the infrastructure deploys to, comma-separated: dev, staging, prod. Defaults to all three. |
| `--agents <list>` | Coding-agent hosts, comma-separated: copilot, codex, claude. Defaults to those the project is set up for. |
| `--governance <profile>` | Governance profile. Defaults to single-maintainer-gitflow. (one of `single-maintainer-gitflow`, `team-gitflow`, `risk-tiered-gitflow`, `none`) |
| `--ai-review <mode>` | Verified AI review in CI; auto turns it on when agents are selected. (one of `auto`, `on`, `off`) |
| `--review-engine <host>` | Which selected agent host runs the verified AI review. |
| `--owners <logins>` | GitHub logins that own the project, comma-separated, for CODEOWNERS. |
| `--check` | Create nothing; show what migrating would do, and exit 3 when the project cannot be migrated as it is. |
| `--out <file>` | Save the plan to this file, outside the project, and create nothing; apply it with --plan. |
| `--plan <file>` | Apply exactly this saved plan, and refuse it if the project or Liftoff changed since. |
| `--yes` | Create the new project without asking. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff migrate --check
liftoff migrate --dir ../service --to ../service-next --stack node-fastify
liftoff migrate --out ../migrate.plan.json
liftoff migrate --plan ../migrate.plan.json --yes
```

## liftoff update

Updates the files .liftoff/manifest.json lists as managed by Liftoff to what this release makes for the project's liftoff.yaml, and removes those it no longer makes. A managed file changed since Liftoff wrote it is left as it is and named. Files the project or a framework owns, such as its source, lock files, environment files, infrastructure and README, and liftoff.yaml itself, are never changed. Update never switches the workflow, governance profile, stack, pattern or agents, and refuses if liftoff.yaml was changed. New files this release makes are offered separately and added only if you choose them, or name them with --add, never over an existing file. It shows the plan and asks before changing anything; the default answer is no. In scripts, pass --yes. Each file is changed only if it is still as planned, and an update that stops part way can be finished or undone with --recover.

Changes files; asks first unless `--yes` is given.

JSON report: `liftoff.update/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--check` | Change nothing; exit 3 when this release has an update for the project. |
| `--out <file>` | Save the plan to this file and change nothing in the project; apply it with --plan. |
| `--plan <file>` | Apply exactly this saved plan, and refuse it if the project or Liftoff changed since. |
| `--add <paths>` | Also add these new files, comma-separated, from those the update offers. |
| `--recover <mode>` | Finish or undo an update that stopped part way. (one of `finish`, `undo`) |
| `--yes` | Change the files without asking. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff update --check
liftoff update
liftoff update --add .claude/skills/liftoff-assess/SKILL.md --yes
liftoff update --out update.plan.json
liftoff update --plan update.plan.json --yes
liftoff update --recover undo
```

## liftoff repair

Finds the files Liftoff wrote that are not as they should be and puts back those you choose: a file Liftoff manages that is missing or was changed by hand, as this release makes it, or a missing file Liftoff wrote for the project, when this release would write it exactly as before. With --patch it applies a reviewed unified diff, such as one a coding agent prepared, to the project's own files within the paths named with --paths: every hunk must match exactly, and it never changes a file Liftoff manages, a framework's file, liftoff.yaml, .liftoff or .git. It shows the plan and asks before changing anything; the default answer is no. In scripts, pass --yes. Each file is changed only if it is still as planned, and a repair that stops part way can be finished or undone with --recover. Like update, it never switches what the project is made of.

Changes files; asks first unless `--yes` is given.

JSON report: `liftoff.repair/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--check` | Change nothing; list the files Liftoff wrote that are not as it left them, and exit 3 when one Liftoff manages needs attention. |
| `--restore <paths>` | Put back these files, comma-separated, from those repair lists. |
| `--patch <file>` | Apply this reviewed unified diff (git diff --no-renames) to the project's own files. |
| `--paths <paths>` | With --patch, the files and directories it may change, comma-separated; it is refused if it changes anything else. |
| `--out <file>` | Save the plan to this file and change nothing in the project; apply it with --plan. |
| `--plan <file>` | Apply exactly this saved plan, with the same --patch and --paths for a patch, and refuse it if anything changed since. |
| `--recover <mode>` | Finish or undo a repair that stopped part way. (one of `finish`, `undo`) |
| `--yes` | Change the files without asking. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff repair --check
liftoff repair
liftoff repair --restore .github/liftoff/review-policy.mjs --yes
liftoff repair --patch fix.diff --paths backend/app
liftoff repair --recover undo
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

## liftoff governance status

Reads .liftoff/governance.json: each action Liftoff took on GitHub, its outcome, and the proof. It does not contact GitHub; use `liftoff governance assess` for the live state.

Read-only.

JSON report: `liftoff.governance-status/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff governance status
liftoff governance status --dir demo --json
```

## liftoff governance assess

Reads the repository on GitHub with your GitHub CLI login, after you agree, and checks each step from the committed governance files to rules GitHub enforces: the branches, the workflows on develop, a real successful run of every required check, the rulesets, their readback, the drift job and the proof. It changes nothing.

Read-only.

JSON report: `liftoff.governance-assessment/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--repo <owner/name>` | The GitHub repository. Defaults to the one the project's origin remote points at. |
| `--use-gh` | Let Liftoff use your GitHub CLI login to reach GitHub, without asking. Liftoff never sees or stores your credentials. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff governance assess
liftoff governance assess --repo octo/demo --use-gh --json
```

## liftoff governance plan

Assesses the repository as `liftoff governance assess` does and lists every checkpoint not yet done: the ones Liftoff can take with `liftoff governance apply-next`, one at a time after you agree, and the ones you take yourself. With --out it saves the plan, bound to the repository and its next step, for apply-next --plan. It changes nothing on GitHub.

Read-only.

JSON report: `liftoff.governance-plan-report/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--repo <owner/name>` | The GitHub repository. Defaults to the one the project's origin remote points at. |
| `--use-gh` | Let Liftoff use your GitHub CLI login to reach GitHub, without asking. Liftoff never sees or stores your credentials. |
| `--out <file>` | Save the plan to this file. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff governance plan
liftoff governance plan --use-gh --out governance.plan.json
```

## liftoff governance apply-next

Assesses the repository again and, if the next checkpoint is one Liftoff can take, says exactly what it will do on GitHub and asks; the default answer is no. It takes that one step only: creating develop, making develop the default branch, applying the rulesets (only after every required check has run, and never changing a ruleset Liftoff did not create), or running the drift job. The step is recorded in .liftoff/governance.json before and after. With --plan, the step must be the one the plan expects. In scripts, pass --yes.

Changes files; asks first unless `--yes` is given.

JSON report: `liftoff.governance-apply/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--repo <owner/name>` | The GitHub repository. Defaults to the one the project's origin remote points at. |
| `--use-gh` | Let Liftoff use your GitHub CLI login to reach GitHub, without asking. Liftoff never sees or stores your credentials. |
| `--plan <file>` | Take the step this saved plan expects, and refuse if the next step differs. |
| `--yes` | Take the step without asking. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff governance apply-next
liftoff governance apply-next --plan governance.plan.json --use-gh --yes
```

## liftoff governance resume

If .liftoff/governance.json records a step that never finished, assesses the repository again and records whether GitHub shows it done. Nothing is repeated or sent: a step that did not happen is offered again by the next `liftoff governance apply-next`, which asks first. If a `verify --prove` was interrupted while trying a forbidden change, it checks on GitHub that the branch is protected and still at the commit that change made, says how it would put the branch back, and asks; the default answer is no. In scripts, pass --yes. Otherwise it changes only .liftoff/governance.json.

Changes files; asks first unless `--yes` is given.

JSON report: `liftoff.governance-resume/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--repo <owner/name>` | The GitHub repository. Defaults to the one the project's origin remote points at. |
| `--use-gh` | Let Liftoff use your GitHub CLI login to reach GitHub, without asking. Liftoff never sees or stores your credentials. |
| `--yes` | Put a branch back without asking. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff governance resume
liftoff governance resume --use-gh --yes
```

## liftoff governance verify

Compares the rules GitHub enforces on each protected branch with the committed rulesets. With --prove, after you agree, it also tries each change the rules forbid on every protected branch: an empty commit pushed on top, a commit forced in beside the head, and deleting the branch. Each must be refused; anything GitHub allows is put back at once. The outcome is recorded in .liftoff/governance.json. Without --prove it changes nothing.

Changes files; asks first unless `--yes` is given.

JSON report: `liftoff.governance-verify/v1`.

| Option | Description |
| --- | --- |
| `--dir <path>` | Project directory. (default `.`) |
| `--repo <owner/name>` | The GitHub repository. Defaults to the one the project's origin remote points at. |
| `--use-gh` | Let Liftoff use your GitHub CLI login to reach GitHub, without asking. Liftoff never sees or stores your credentials. |
| `--prove` | Also try the changes the rules forbid, and record whether each was refused. |
| `--yes` | Run the proof without asking. |
| `--json` | Print one JSON report on stdout. |
| `--help` | Show help for this command. |

```bash
liftoff governance verify
liftoff governance verify --prove
```
