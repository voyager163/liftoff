---
name: liftoff-risk
description: Explain how much review the current change needs. Reports the risk tier, review depth, required human approvals and the paths that always need a person, using the repository's review policy, and suggests how to lower risk by splitting the change. Use before opening a pull request or when asked who needs to review a change.
---

# Risk tier and required review

The change sets the tier, not the author. The repository's policy in
`.github/review-policy.yml` maps what a change touches to a tier, and the
governance profile maps the tier to required human approvals. CI enforces the
same policy, read from the base branch, so a pull request cannot lower its
own tier.

<!-- include: negotiate -->

## Steps

1. Run `liftoff review classify --base <branch> --json`, using the branch
   the pull request will target (usually `develop`). Add `--author <login>`
   when you know the author's GitHub login.
2. Report:
   - the tier and review depth, and why (the reasons and their paths);
   - how many independent human approvals the pull request needs;
   - any paths that always need a person;
   - whether the policy came from the base branch (verified) or from the
     working tree (unverified).
3. When the tier is high because of a few files, suggest splitting them into
   their own pull request so the rest can take a lighter path. Never suggest
   editing the policy, renaming files or moving code to avoid review.

## Without Liftoff

Read `.github/review-policy.yml` from the base branch
(`git show origin/develop:.github/review-policy.yml`) and apply its rules by
hand: each file takes the highest tier of the rules it matches, the change
takes the highest file tier, and changes to workflows, rulesets, CODEOWNERS,
the policy itself or AI-review instructions are always high. Say that the
result was not computed by Liftoff.

## Remember

- Bot approvals never count as human approvals.
- The person who asked an agent to write a change is accountable for it, as
  if they had typed it.
- An approval applies to the commit it was given on. New commits need the
  approval again when the tier requires one.
