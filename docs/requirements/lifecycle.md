# Existing projects

Projects that already exist when Liftoff meets them: what the Liftoff
releases before the rebuild left behind, and assessing, adopting, updating,
repairing and migrating projects.

## LEGACY-001 Records from before the rebuild are inventoried, never run

In a directory without `liftoff.yaml`, Liftoff looks for what the releases
before the rebuild (up to 0.12.3) wrote there, at those releases' own paths,
and puts each record it finds in one of four states:

- **readable**: recognized and reported, kept unchanged as the project's
  history, and never counted as current configuration or proof;
- **migratable**: readable, and adopting the project can carry what it says
  into `liftoff.yaml`: the old manifest (formats 2 to 7) and the old
  configuration;
- **executable**: this release could continue or act on it. No record from
  before the rebuild is: nothing old is resumed, applied or run again;
- **unsupported**: anything not recognized (LEGACY-002).

An update or repair the old release did not finish blocks any change to the
project until it is finished or undone with that release. Records at
generic paths, such as `governance/`, are looked at only beside a record only
the old releases wrote, never in an unrelated repository. A link, or a
directory Liftoff may not search, never marks a project by itself.

- Given a project from 0.12.3 with its manifest, configuration and
  governance activation records, when Liftoff inventories it, then the
  manifest and configuration are migratable, the activation records are
  readable history, and no record is executable.
- Given the journal of an old update that did not finish, then the
  inventory says to finish or undo it with the old release first.
- Given only a `governance/plans` directory, then the directory is not a
  project from before the rebuild.

Verification: test

## LEGACY-002 Unknown and newer formats fail safely

A record is unsupported, with the reason, when it is:

- an old manifest not written by Liftoff, or with a format version that is
  missing, older than 2 or newer than 7;
- an activation state with a format version other than 1, 2 or 3;
- an old configuration with fields no old release wrote, or without the
  project's name and type;
- not valid JSON, or not a JSON object;
- a link, or a directory where the old release kept a file;
- something Liftoff is not allowed to read.

A directory on the way to records that is a link, or that Liftoff may not
look into, is reported once, at its own path.

Liftoff does not guess past an unsupported record.

Verification: test

## LEGACY-003 Records that can hold files, credentials or state are never read

Liftoff reads only the old manifest, configuration and activation state, and
no more than 1 MiB of each: a larger file is not read, and one that grows
while being read is read no further. It follows no link, at the record or on
the way to it, and reads nothing if a directory on the way changed while
the record was being opened. Opening a record never waits, even if it was
swapped for a FIFO. These are noted by their presence alone:

- journals of unfinished changes, which hold whole copies of files;
- repair and activation history;
- evidence, plans and approvals;
- credential records.

Verification: test

## CHANGE-001 A change plan names every file it changes, before and after

A plan to change an existing project (the operations `update`, `repair`,
`adopt`, `workflow-set`, `profile-set` and `agents-add`) lists every file it
changes:

- its repository-relative path;
- the sha256 of the file as it must be now, or that it must not exist;
- the sha256 it will have, or that it is removed;
- for a file that is kept, who owns it and whether it is executable.

Its only effect is `modify-files`. It is sealed like an init plan, so an
edited plan is refused, and each kind of plan is refused where the other is
expected. These make the plan invalid:

- a path outside the project, or inside a `.git` directory at any depth;
- a control character, a character Windows forbids in a name, or an
  invisible character macOS leaves out of a name, such as a zero-width
  joiner;
- a name Windows would read as another file: a trailing dot or space, a
  `:`, a device name such as `nul`, `nul .txt` or `conin$`, or an 8.3 short
  name such as `GIT~1`;
- a path named twice, ignoring letter case and how an accented letter is
  encoded, as macOS and Windows do;
- a change that changes nothing.

Verification: test

## CHANGE-002 A file changed since the plan is never overwritten

Before anything changes, and once no other change can start, every file must
still be exactly as the plan says: the same content, a regular file and not
a link, or still absent. If any is not, nothing changes and each such file
is named. So a change that finished while this one was being prepared is
never overwritten. Each new file's content must hash to what the plan says
and be no larger than 64 MiB, and a plan whose journal could not be read
back is refused, both before anything changes. For each file, its original
is copied as every file is read (following no link, never waiting on a
FIFO, never past the limit, every byte written) and its replacement
prepared, with any directory it needs, made one at a time and never through
a link. The file and each directory on the way are then checked
again, and only the rename comes after. A file replaced while it was being
read, as an editor's save does, counts as changed. If it changed meanwhile,
it and the files after it are left alone, and the change can be recovered
(CHANGE-003). Node has no rename relative to an open directory, so a
directory swapped for a link in the instant between that last check and the
rename is the one case Liftoff cannot see.

Verification: test

## CHANGE-003 A change that stops part way can be finished or undone

A change, and any recovery, holds a lock at `.liftoff/change.lock` while it
runs, so only one runs at a time and recovery never runs beside a change
still being made. A lock is never taken over, since no step of taking it
over could keep another process out meanwhile. It is reported, saying
whether its process is still running, with how to clear it. Nothing is
created for a project directory that is not there, such as one moved since
its plan was made.

Before checking any file, Liftoff writes a journal at
`.liftoff/change-journal.json`: whole, under another name, then renamed into
place. The lock and journal are kept only in a real `.liftoff` directory in
the project, never through a link to one elsewhere, so there is no journal
behind a link. Before each file is replaced or removed, Liftoff keeps a
byte-for-byte copy of it beside the project, in a directory only the person
can open, with a marker naming the project directory (by its inode, which
survives the disk being attached again) and the plan. Generated projects
ignore the journal in Git, with the lock.

If a change stops part way, the journal stays and `liftoff validate` reports
it. A journal that cannot be read comes with what to do: if it is empty, the
change stopped before any file changed, so it can be deleted. Recovery
finishes or undoes the change, deciding each file from what is there now:

- a file already as wanted is left alone;
- a file as the change found it (finishing), or as the change left it
  (undoing), is replaced;
- any other file was changed by something else and is never overwritten. It
  is named, and the journal stays until it is resolved.

`liftoff.yaml` and the manifest change only once every other file has, so
the manifest never describes files that are not there.

Finishing and undoing can follow each other until one completes, because
the kept copies are copied into place, never used up. Recovery refuses a
journal whose kept copies are missing, are a link, or belong to another
copy of the project, such as one duplicated after the change stopped.

Verification: test

## CHANGE-004 Files change one at a time, the manifest last

Each file is replaced in one step, keeping the executable bit planned. The
project's files change first, then `liftoff.yaml`, then
`.liftoff/manifest.json`, so the manifest never lists files that were not
written. Once every file has changed, the journal and the kept copies are
removed. A change across several files is not atomic; the journal is how an
interrupted one is recovered.

Verification: test

## ASSESS-001 Assessing a project changes nothing and runs nothing

`liftoff assess` assesses the root of a Git repository, or any other
directory named with `--dir`. It refuses the root of the file system and
the home directory. It writes no file, receipt or record into the project or
anywhere else, runs no project script or tool, installs nothing, asks for no
credentials and, without `--live`, contacts no network service.

It reads only the declarations it interprets: `pyproject.toml`,
`package.json`, `go.mod`, Compose files, `vitest.config.*`,
`.terraform.lock.hcl` and the workflows in `.github/workflows`, plus what
`liftoff validate` reads in a Liftoff project. Every other file is seen by
name only. Files that may hold secrets or state, such as `.env`,
`*.tfstate`, `*.tfvars`, private keys and `.npmrc`, are listed as not read.

- Given a generated project, when it is assessed, then no file in it
  changes and only those declarations and Liftoff's own files are read.
- Given a directory that is not the root of a Git repository, when it is
  assessed without `--dir`, then the command refuses and says to name it.

Verification: test

## ASSESS-002 The walk is bounded and follows no link

The assessment walks the project breadth first, sorted by name, and stops
at 50,000 entries, 10,000 entries in one directory, 12 directories deep,
300 declarations read and 512 KiB per declaration. It never follows a link:
a link, or a directory that changes while it is listed, is not walked.
Installed dependencies, caches and build output, such as `node_modules`,
`.venv`, `dist` and `.git`, are not walked.

Everything not walked or read is reported as a gap, with its path and why:
skipped by rule, a link, closed to this user, changed while read, past a
limit, possibly holding secrets or state, too large, or GitHub without
`--live`.

- Given a link to a directory outside the project, when the project is
  assessed, then nothing behind the link is read and the link is a gap.
- Given more entries than a limit allows, when the project is assessed,
  then the walk stops and the gap names the limit.

Verification: test

## ASSESS-003 Findings keep unknown, unsupported, inaccessible and noncompliant apart

The project is checked against the standard this release generates, never
against the newest version of anything in a registry. It reports what it
found: the project's applications, frontends and infrastructure and their
stacks, its development workflow and its coding-agent hosts. Each finding
names its check and is one of:

- **compliant**: seen, and as the standard asks;
- **noncompliant**: seen, and different from the standard;
- **unknown**: could not be told, for example because a declaration is not
  valid or part of the project was not walked;
- **unsupported**: something this release has no standard for, such as a
  Rust application or Bicep infrastructure, which is not checked further;
- **inaccessible**: closed to this user.

A check whose answer lies where the walk did not reach is unknown or
inaccessible, never noncompliant. Each finding lists the paths it rests on
and whether each was seen by name, read, or read from GitHub. The same
project gives the same report, unless a directory has more entries than the
limit, when which of them are listed is up to the file system.

The checks cover: whether the project is Liftoff's (and, in a Liftoff
project, what `liftoff validate` reports); each part's stack; lock files and
runtime versions; tests and a coverage threshold; a container build; a
database's migrations and local service; in a project set up for coding
agents, `AGENTS.md` and review skills for each host; pull request
workflows, `ci-gate`, CodeQL, dependency review and actions pinned to commit
SHAs; the review policy, rulesets, pull request template, `REVIEW.md`,
`GOVERNANCE.md` and Dependabot (a Liftoff project that selects no
governance profile needs no rulesets or `GOVERNANCE.md`); locked OpenTofu
providers; and `README.md`.

- Given a project generated by this release, when it is assessed, then
  every finding is compliant.
- Given a declaration that is not valid, a directory closed to this user and
  a Rust crate, when the project is assessed, then they are unknown,
  inaccessible and unsupported, not noncompliant.

Verification: test

## ASSESS-004 Every finding that needs action says who acts next

Next actions are grouped by who takes them: **project** (the team changes
the project), **liftoff** (a command this release has does it, and it is
named), **access** (someone grants access) and **unavailable** (this release
cannot help yet, such as adopting a project). Each lists the checks it
answers. Only commands this release has are named. The command exits 0 when
every finding is compliant and 3 otherwise.

Verification: test

## ASSESS-005 Live assessment reads GitHub only when asked and allowed

With `--live`, the assessment also reads the repository's governance on
GitHub through the same read-only path as `liftoff governance assess`, with
the person's GitHub CLI login, after they agree or with `--use-gh`. Each
governance checkpoint becomes a finding. A repository GitHub refuses to
show is inaccessible, and any other failure is unknown; the local
assessment is still reported. `--repo` and `--use-gh` are refused without
`--live`.

Verification: test
