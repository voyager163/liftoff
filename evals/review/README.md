# Review evaluations

Each directory is one case the AI review pipeline is scored against, so a
change to its prompts, skills, model or settings is measured instead of
assumed. The Review evals workflow runs every case nightly and on demand.

| File | Content |
| --- | --- |
| `case.json` | What the case is and where the defect is |
| `change.patch` | The change under review, applied on top of `develop` |
| `notes.md` | Optional: how the defect was found and fixed |

`case.json` fields:

- `kind`: `seeded` (a defect planted on purpose), `missed-bug` (a real defect
  that reached a release), `clean` (a harmless change) or `false-positive`
  (a change a reviewer wrongly flagged).
- `description`: what the reviewer is told the change is for. It must not
  give the defect away.
- `file` and `line`: where the defect is, for `seeded` and `missed-bug`
  cases. A confirmed finding within `tolerance` lines (default 8) counts.
- `summary`: one sentence for people reading the results.

A run reports, per case, whether a defect was caught and how many Important
findings did not point at it. A reviewer change that lowers the catch rate or
raises false positives should not be kept. Use the `liftoff-review-eval`
skill to turn a revert or incident into a new case. Never put secrets or
customer data in a case.

When a patch no longer applies because the code moved on, the case is
reported as stale rather than passed; refresh the patch against `develop`.
