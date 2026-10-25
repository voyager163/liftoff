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
  the step must be the one the saved plan expected.
- **Recorded before and after.** Each step is written to
  `.liftoff/governance.json` when it starts and when it ends, with its
  outcome. If it is interrupted, apply-next stops until `resume` has checked
  it.
- **Never weakening protection.** Liftoff only creates or updates rulesets
  with its own names, and only when they are not active. Any other ruleset,
  such as a stricter organization rule, is left as it is. GitHub enforces the
  strictest of all active rules, so adding Liftoff's cannot loosen anything.
- **Admins only for rulesets.** Without admin rights, the rulesets step is
  left for an admin.

## The proof

`liftoff governance verify --prove` runs only when the rulesets are active
and match. On each protected branch it tries an empty commit pushed on top,
a commit forced in beside the head, and deleting the branch. GitHub must
refuse each one. If it allows one, Liftoff puts the branch back at once, at
the head it had, and the proof fails. The outcome, and the rulesets it
proved, are recorded; new or replaced rulesets need a new proof.

Run the proof in a repository you are ready to protect. If the rules are not
enforced, the proof briefly changes the branch before putting it back.

## Limits

- Pull requests that check a failing change is blocked, and that a workflow
  edit faking a green check is caught, are not automated yet. The review
  policy's always-human paths and CODEOWNERS cover workflow changes.
- These commands have been tested against a simulated GitHub, not yet
  against a real repository, which GOV-005 tracks.
