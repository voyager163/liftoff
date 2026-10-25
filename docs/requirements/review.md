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
native: rulesets require code-owner review and CODEOWNERS covers every
always-human path, including workflows.

Verification: test
