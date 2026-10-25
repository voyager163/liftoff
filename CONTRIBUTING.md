# Contributing to Liftoff

Thank you for your interest in Liftoff. Bug reports, reproductions,
root-cause analysis, documentation feedback and feature ideas are the most
valuable ways to help, and they all happen in
[GitHub Issues](https://github.com/voyager163/liftoff/issues).

Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md). See
[SUPPORT.md](SUPPORT.md) for the right channel and
[GOVERNANCE.md](GOVERNANCE.md) for how decisions are made.

## Code contributions are by invitation

**Liftoff does not accept unsolicited pull requests from outside
contributors.** Pull requests that were not invited in an issue are closed
with a pointer back to Issues.

Liftoff has one maintainer. Fitting a change into the design, the roadmap and
the release process usually takes more time to review than to implement, so
the maintainer writes the code. The hard and valuable parts of a fix are
understanding the problem and agreeing on the right behavior, and that is
where your help counts most.

The maintainer may invite a code or documentation change in an issue. If you
are invited:

1. Sign the [Contributor License Agreement](docs/CLA.md). The CLA Assistant
   bot asks you on your pull request; reply with the exact sentence it gives.
   You keep the copyright in your work. The CLA gives the maintainer, and
   everyone who receives Liftoff, a broad license to use your contribution,
   including under licenses other than GPL-3.0-only.
2. Create a branch from `develop`, in a fork if needed.
3. Open a pull request into **`develop`**, link the inviting issue, and fill
   in the pull request template.

## Reporting a bug

Search [existing issues](https://github.com/voyager163/liftoff/issues) first.
If the problem is already reported, add new information there instead of
opening a duplicate. Otherwise use the
[bug report form](https://github.com/voyager163/liftoff/issues/new?template=bug_report.yml)
and include:

- Clear steps to reproduce the problem, using synthetic inputs.
- What you expected and what actually happened.
- The Liftoff version or commit, your operating system, and relevant runtime
  versions.
- The relevant part of any error output, manually checked for sensitive data.
- Root-cause analysis or a suggested approach, if you have one.

## Requesting a feature or reporting a docs problem

Use the [feature request](https://github.com/voyager163/liftoff/issues/new?template=feature_request.yml)
or [documentation](https://github.com/voyager163/liftoff/issues/new?template=docs_issue.yml)
form. Start with the problem and who it affects, not just a proposed
implementation. If someone has already asked for the same thing, add a 👍
reaction and your use case to that issue. A feature request is a discussion,
not a commitment to build it.

## Keep public reports safe

Issues, pull requests and attachments are public. Never post credentials,
tokens, `.env` contents, personal data, private source code or customer data.
Automatic redaction by a tool is not a guarantee that a log is safe to share.

Report vulnerabilities **privately** as described in [SECURITY.md](SECURITY.md),
never in a public issue.

## AI-assisted reports and changes

You are welcome to use AI tools, but you are responsible for what you submit.
Check that a report describes behavior you actually observed, that
reproduction steps work, and that any analysis is accurate. Don't paste long
generated text you haven't read. For invited pull requests, mention material
AI assistance in the description where it affects provenance or review.
