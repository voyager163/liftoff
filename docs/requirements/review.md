# Review policy and approvals

The risk policy decides how much review a change needs from what the change
touches. It follows the layered model in
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/):
the change sets the tier, not the author.

## REVIEW-001 Policy is strict and versioned

`.github/review-policy.yml` has `version: 1` and a known profile. Unknown
fields, malformed YAML, invalid tiers and bad globs are rejected with a message
that names the field.

- Given a policy with an unknown key, when it is parsed, then parsing fails and
  names the key.
- Given an absolute or backslash path glob, when it is parsed, then parsing fails.

Verification: test

## REVIEW-002 Change sets the tier

Each changed file takes the highest tier of every rule it matches, or the
default tier when nothing matches. The change takes the highest file tier.
Renamed files are classified by both their old and new path.

- Given a docs-only change under a low rule, then the tier is low.
- Given one docs file and one file matching a high rule, then the tier is high.
- Given a file moved out of a high path, then the tier is high.

Verification: test

## REVIEW-003 Built-in rules cannot be removed

Changes to the review policy, the policy check, workflows, rulesets, review
instructions (REVIEW.md, AGENTS.md, CLAUDE.md, Copilot instructions, agent
skills and agents) and CODEOWNERS are always high tier and always need a
person, whatever the repository's own rules say.

- Given a policy that marks `.github/**` as low, when a workflow changes, then
  the tier is still high and the change is always-human.

Verification: test

## REVIEW-004 Large changes and untrusted authors escalate

A change larger than `large_change.lines` is raised to at least its tier.
Authors not on `trusted_authors` never get a tier below `untrusted_author_tier`.

- Given 1,200 changed lines and the default policy, then the tier is high.
- Given a low-risk change by an untrusted author, then the tier is medium.

Verification: test

## REVIEW-005 Profiles map tiers to required approvals

| Profile | low | medium | high | always-human minimum |
| --- | --- | --- | --- | --- |
| single-maintainer-gitflow | 0 | 0 | 0 | 0 |
| team-gitflow | 1 | 1 | 2 | 1 |
| risk-tiered-gitflow | 0 | 1 | 2 | 1 |
| none | 0 | 0 | 0 | 0 |

Verification: test

## REVIEW-006 Only accountable human approvals count

An approval counts only when it is the reviewer's latest decision, it is for
the current head commit, the reviewer is not the author, is not a bot and has
write access. A later change request or dismissal cancels an earlier approval;
a later comment does not.

- Given a bot approval, then it is ignored with a reason.
- Given an approval on an older commit, then it is ignored.
- Given approve then request changes, then the reviewer is not an approver.
- Given two approvals from one reviewer, in any letter case, then they count
  once.

Verification: test

## REVIEW-007 Local classification matches CI

`liftoff review classify` and the `review-policy` CI check run the same domain
module. The CI copy is a bundle generated from source and committed at
`.github/liftoff/review-policy.mjs`; a check fails if it differs from a fresh
build.

Verification: test

## REVIEW-008 Policy is read from the base branch

CI and `liftoff review classify` read the policy from the base ref, so a pull
request cannot lower its own tier by editing the policy. Locally, when the base
ref has no policy, the working-tree policy is used and the result is marked
unverified.

Verification: test

## REVIEW-009 The policy check cannot be changed by the pull request

The authoritative `review-policy` check runs from the base branch's workflow
definition (`pull_request_target`, or `workflow_dispatch` from the pull
request's base branch) and never checks out or runs pull request code. Editing
the workflow, the policy or the bundled check in a pull request does not
change how that pull request is judged.

Verification: live

## REVIEW-010 The check reports a status on the head commit

The check posts a `review-policy` commit status on the pull request's head
commit: success when the required approvals are present, failure when they
are not, and error when it cannot evaluate. A dispatched run refuses to run
from any branch other than the pull request's base. In a merge queue it
reports success on the queue's merge commit, because every queued pull
request already passed. Any other trigger fails closed.

A repository writer can forge a commit status, so the dynamic approval
counts this check enforces are not tamper-proof. The tamper-proof floor is
native: the rulesets' approval minimum and, where it can apply (PROJ-008),
code-owner review, with CODEOWNERS covering every always-human path,
including workflows.

Verification: test

## REVIEW-011 Approval rules hold on GitHub

On a GitHub repository with a team or risk-tiered project's rulesets
applied:

- A pull request that needs an approval cannot merge until someone other
  than its author, with write access, approves its head commit.
- A new push dismisses that approval, and a bot approval or one for an
  older commit does not satisfy `review-policy`.
- A high-tier change with one approval stays blocked.
- A review on a pull request from a fork, even a comment-only review by its
  author, re-runs `review-policy` without anyone dispatching it by hand.

One maintainer can observe all of this: a GitHub App opens the test pull
requests, so the maintainer is not their author and can approve them.
GitHub never lets authors approve their own pull requests, so author
approvals, and a high-tier change passing with two approvals, are covered by
the tests for REVIEW-006 and REVIEW-010 instead. Until the rest has been
observed, the team and risk-tiered profiles are described as not yet
qualified.

Verification: live

## REVIEW-012 A review re-checks the policy, on pull requests from forks too

`pull_request_target` does not fire on reviews, and a review on a pull
request from a fork only gets a read-only token. So a submitted or dismissed
review starts a workflow with no permissions that runs no code; when it
completes, a refresh workflow runs from the default branch. That workflow
finds the open pull requests whose head is the reviewed commit and dispatches
`review-policy` from each one's base branch. It checks out and runs no pull
request code, so it can delay a pass but never fake one.

Verification: test

## AIREVIEW-001 Findings are found independently and verified by vote

Medium-risk changes get two finder passes and high-risk changes three, each
with a different focus (correctness; failure and recovery; security).
Candidates from all passes are merged when they share a fingerprint or point
at the same file within three lines. Three separate verifier runs judge every
candidate without seeing the finder's reasoning, and a candidate is reported
only when a majority confirms it. Uncertain or missing verdicts count against
it. Low-risk changes rely on the managed reviewer alone.

Verification: test

## AIREVIEW-002 Reports start with the count and tag every finding

The review summary starts with the number of findings and their tags, or says
"No findings. Nothing to fix." Each finding is tagged Important, Nit or
Pre-existing, sorted most severe first, carries its failure scenario and fix,
and is posted inline when its line is in the diff, otherwise in the summary.
At most three nits are reported.

Verification: test

## AIREVIEW-003 Reviews converge instead of looping

A finding is never posted twice: earlier findings are recognised by a
fingerprint, and only fingerprints in comments posted by the review bot
itself count. From the third round, finders review only the commits since the
last round. After three rounds the pipeline posts one note asking the author
to reconsider the approach and stops. A commit that was already reviewed is
not reviewed again.

Verification: test

## AIREVIEW-004 Agents cannot be steered or given write access by the pull request

The review runs from the base branch's workflow, scripts, skills and review
instructions, so a pull request cannot change how it is reviewed. The pull
request's files are a separate checkout that agents only read, and a trusted
step writes the diff for them. Agents get file-reading tools only (Codex: a
read-only, offline sandbox), no shell, write or network access, and a
read-only GitHub token. Only a separate job that runs no agent posts the
review. Fork pull requests and repositories without the agent's secret report
"not run", never success.

Verification: test

## AIREVIEW-005 An incomplete review fails visibly

If no finder pass returns a usable result, or fewer than two verifier runs do
when there are candidates, publishing fails with an error instead of posting a
review that looks complete. Partial failures are listed in the summary.

Verification: test

## EVAL-001 Review quality is measured against known cases

`evals/review/` holds seeded and real defects the reviewer should catch and
clean changes where any Important finding is a false positive. Cases are
validated, and every committed patch must still apply, so a case cannot go
stale unnoticed.

Verification: test

## EVAL-002 Evaluations run without giving the answer away

The eval runner reviews each case as one commit on top of `develop`, tells the
finders only the case's neutral description, scores whether a confirmed
finding points at the defect, counts Important false positives, and fails its
report when any case produced no score.

Verification: test

## EVAL-003 Human attention and reviewer quality are tracked with a guardrail

A weekly read-only job reports merged pull requests, median and p95 hours to
merge, median and p95 human approvals per pull request, the share of
pull requests that passed verified AI review in one round, the mean number of
rounds, and reverts. Bot approvals are not counted as human approvals.

Verification: test
