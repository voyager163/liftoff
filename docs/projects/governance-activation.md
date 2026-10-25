# Activating governance

A generated project with a GitFlow profile commits its governance:
rulesets in `.github/rulesets/`, CODEOWNERS, the review policy and the
workflows its rules require. None of it is enforced until GitHub applies the
rulesets, and they should only be applied once every check they require
exists. `liftoff governance` takes a repository there one checkpoint at a
time, and never further than you agree to.

## The checkpoints

| # | Checkpoint | Who takes it |
| --- | --- | --- |
| 1 | The governance files in the project are valid | you, if `liftoff validate` reports errors |
| 2 | `develop` and `main` exist, and `develop` is the default branch | Liftoff creates `develop` from `main` and makes it the default |
| 3 | The default branch has the project's workflows | you push the generated files |
| 4 | Every required check (`ci-gate`, `review-policy`) has run successfully on a pull request, from GitHub Actions | you open a pull request |
| 5 | The rulesets are applied and active | Liftoff, as a repository admin |
| 6 | GitHub enforces exactly the committed rules | you, if anything differs |
| 7 | The governance drift job has passed | Liftoff starts it |
| 8 | Protected branches refuse direct, forced and deleting pushes | Liftoff, with `verify --prove` |

Every checkpoint is judged by what GitHub shows now, never by what Liftoff
did before. Rulesets come after the checks they require have really run, so a
new rule never waits on a check that does not exist.

## The commands

| Command | What it does |
| --- | --- |
| `liftoff governance assess` | Reads GitHub and lists the checkpoints and the next step. Changes nothing. |
| `liftoff governance plan [--out file]` | The same, listing who takes each step left; saves the plan for apply-next. |
| `liftoff governance apply-next [--plan file] [--yes]` | Takes the next step Liftoff can take, after you agree. |
| `liftoff governance resume` | Checks a step that was interrupted against GitHub, instead of repeating it. |
| `liftoff governance status` | Shows what was recorded, without contacting GitHub. |
| `liftoff governance verify [--prove] [--yes]` | Reads back the enforced rules; with `--prove`, tries what they forbid. |

They reach GitHub with your GitHub CLI login (`gh`), only after you agree or
pass `--use-gh`; Liftoff never sees or stores your credentials. The
repository is the one the project's `origin` remote points at, or `--repo`.

## What Liftoff changes, and what it never does

- **One step at a time.** apply-next takes only the next step, says exactly
  what it will do, and asks first; the default answer is no. With `--plan`,
  the step must be the one the saved plan expected, for the same repository
  by GitHub's id.
- **Recorded before and after.** Each step is written to
  `.liftoff/governance.json` when it starts and when it ends, with its
  outcome. If it is interrupted, apply-next stops until `resume` has checked
  it.
- **Never weakening protection.** Liftoff only creates or updates rulesets
  with its own names, and only when they are not active. It reads each one
  again just before changing it, and leaves it if anyone changed it since.
  Any other ruleset, such as a stricter organization rule, is left as it is.
  GitHub enforces the strictest of all active rules, so adding Liftoff's
  cannot loosen anything.
- **Admins only for rulesets.** Without admin rights, the rulesets step is
  left for an admin.

## The proof

`liftoff governance verify` compares what GitHub enforces on each branch,
which branches each ruleset applies to and who may bypass it with the
committed rulesets. Reading who may bypass a ruleset needs a repository
admin. Rulesets that select branches by pattern, such as `release/*` or
`~ALL`, cannot be verified branch by branch, so they never match.

`liftoff governance verify --prove` runs only when the rulesets are active
and match. On each protected branch it tries an empty commit pushed on top,
a commit forced in beside the head, and deleting the branch. A rule must
refuse each one; any other answer, such as a rate limit, leaves the proof
unfinished rather than passed. If GitHub allows one, Liftoff puts the
branch back at once, at the head it had just before, and the proof fails.
The outcome, and the rulesets as they were proved, are recorded: a new,
replaced or edited ruleset needs a new proof.

Each change is written to `.liftoff/governance.json` before it is tried and
removed once the branch is as it was. Liftoff puts a branch back only while
it is still exactly where the change left it, so a merge made meanwhile is
never undone; that branch is left for you to check. If a branch cannot be
put back, for example because another rule forbids rewinding it, the proof
stops and the record stays: `liftoff governance resume` puts it back once
GitHub allows, and apply-next and verify wait until then.

Run the proof in a repository you are ready to protect, when nothing is
being merged. GitHub's API cannot make a change only if the branch is still
where it was read, so a merge in the moment between Liftoff's last read and
its change could be undone; Liftoff reads the branch again straight before
each change and stops if it moved. If the rules are enforced, nothing
changes at all.

## Limits

- Pull requests that check a failing change is blocked, and that a workflow
  edit faking a green check is caught, are not automated yet. The review
  policy's always-human paths and CODEOWNERS cover workflow changes.
- These commands have been tested against a simulated GitHub, not yet
  against a real repository, which GOV-005 tracks.
