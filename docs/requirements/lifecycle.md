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
swapped for a FIFO. These are noted by their presence alone, and the walk of
`liftoff assess` and `liftoff adopt` never goes into them:

- journals of unfinished changes, which hold whole copies of files;
- repair and activation history;
- evidence, plans and approvals;
- credential records.

Verification: test

## CHANGE-001 A change plan names every file it changes, before and after

A plan to change an existing project (the operations `update`, `repair`,
`adopt`, `migrate-cleanup`, `workflow-set`, `profile-set` and `agents-add`)
lists every file it changes:

- its repository-relative path;
- the sha256 of the file as it must be now, or that it must not exist;
- the sha256 it will have, or that it is removed;
- for a file that is kept, who owns it (`managed`, `seeded` or `framework`
  as the manifest says, or `project` for a file the manifest does not list)
  and whether it is executable.

It also lists each file the change rests on without changing it, with the
sha256 it must still have or that it must still not exist (CHANGE-002), so
a saved plan carries them too. Its only effect is `modify-files`. It is sealed like an init plan, so an
edited plan is refused, and each kind of plan is refused where the other is
expected. These make the plan invalid:

- a path outside the project, or inside a `.git` directory at any depth;
- a control character, a character Windows forbids in a name, or an
  invisible character macOS leaves out of a name, such as a zero-width
  joiner;
- a name Windows would read as another file: a trailing dot or space, a
  `:`, a device name such as `nul`, `nul .txt` or `conin$`, or an 8.3 short
  name such as `GIT~1`;
- a path named twice, among the files it changes and those it rests on,
  ignoring letter case and how an accented letter is encoded, as macOS and
  Windows do;
- a change that changes nothing.

Verification: test

## CHANGE-002 A file changed since the plan is never overwritten

Before anything changes, and once no other change can start, every file must
still be exactly as the plan says: the same content, a regular file and not
a link, or still absent. So must any file the change rests on without
changing it, such as `liftoff.yaml` for an update, or a file whose manifest
entry an update rewrites, which must still have the content seen, or still
be absent. If any is not, nothing changes and each such file is named. So a
change that finished while this one was being prepared is never
overwritten. Each new file's content must hash to what the plan says
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

Finishing also needs every file the change rests on (CHANGE-001) to be as
it was: if one is not, nothing is finished, it is named, and the change can
still be undone.

Finishing and undoing can follow each other until one completes, because
the kept copies are copied into place, never used up. Recovery refuses a
journal whose kept copies are missing, are a link, or belong to another
copy of the project, such as one duplicated after the change stopped.

Verification: test

## CHANGE-004 Files change one at a time, the manifest last

Each file is replaced in one step, keeping the permissions of the file it
replaces, so a private file stays private; only when the plan changes
whether it is executable is execute permission added wherever it may be
read, or removed. The
project's files change first, then `liftoff.yaml`, then
`.liftoff/manifest.json`, so the manifest never lists files that were not
written. Once every file has changed, the journal and the kept copies are
removed. If the kept copies or the lock cannot be removed then, the change
is still complete, and what is left is named for the person to delete. A
change across several files is not atomic; the journal is how an
interrupted one is recovered.

A change, or its recovery, cancelled with Ctrl+C stops between files:
before the first file, nothing changes; after it, the change stops part way
and can be recovered.

Verification: test

## ASSESS-001 Assessing a project changes nothing and runs nothing

`liftoff assess` assesses the root of a Git repository, or any other
directory named with `--dir`. It refuses the root of the file system and
the home directory. It writes no file, receipt or record into the project or
anywhere else, runs no project script or tool, installs nothing, asks for no
credentials and, without `--live`, contacts no network service. Ctrl+C
while it assesses exits 4 and reports nothing.

It reads only the declarations it interprets: `pyproject.toml`,
`package.json`, `go.mod`, Compose files, Vitest, Vite and Jest
configuration, `pytest.toml`, `.coveragerc`, `setup.cfg`, `tox.ini`, `pytest.ini`,
`.terraform.lock.hcl` and the workflows in `.github/workflows`, plus what
`liftoff validate` reads in a Liftoff project, without following a link to
any of them. Every other file is seen by name only. Files that may hold secrets or state, such as `.env`,
`prod.env`, `.envrc`, `*.tfstate`, `*.tfvars`, private keys, `.npmrc`,
`credentials.json`, `secrets.toml` and SQLite databases, are listed as not
read; a workflow in `.github/workflows` never is, whatever its name.

- Given a generated project, when it is assessed, then no file in it
  changes and only those declarations and Liftoff's own files are read.
- Given a directory that is not the root of a Git repository, when it is
  assessed without `--dir`, then the command refuses and says to name it.

Verification: test

## ASSESS-002 The walk is bounded and follows no link

A link in the path that names the project directory is followed once, before
anything is read; from then on the project directory must stay the same
directory: every listing and read checks it, and an assessment during which
it was replaced is refused. The assessment walks
the project breadth first, sorted by name, and stops
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
inaccessible, never noncompliant. In a directory that is not the root of a
Git repository, what GitHub, coding agents and Liftoff look for at the root
(workflows, governance files, `AGENTS.md`, review skills and
`liftoff.yaml`) is unknown when it is not found, since the root may have
it. A member of an npm or uv workspace, by the workspace's member and
exclusion globs, may have its lock file at the workspace's root, and a
workspace's root may itself be an application. Coverage settings may also
be at the root of a workspace the part is in. A `pyproject.toml` that is
not valid TOML is unknown, whatever it names. A coverage threshold counts
only when it is configured: `fail_under` or `--cov-fail-under` above 0, or a
non-empty `thresholds` or `coverageThreshold` object, never a mention in a
description or a comment; one set in code that cannot be read statically is
unknown. OpenTofu root modules make one part per kind of provider their
lock files lock, so Azure and another cloud are separate parts; a root
module whose lock file could not be read, or that has none, is unknown,
never unsupported. Each finding lists the paths it rests on
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
cannot help yet, such as adding a coding-agent host to a Liftoff project).
`liftoff adopt` is named for a project that is not Liftoff's only when a
backend this release supports was found, and `liftoff migrate` otherwise.
Each lists the checks it answers. Only commands this release has are named. The command exits 0 when
every finding is compliant and 3 otherwise.

Verification: test

## ASSESS-005 Live assessment reads GitHub only when asked and allowed

With `--live`, the assessment also reads the repository's governance on
GitHub through the same read-only path as `liftoff governance assess`, with
the person's GitHub CLI login, after they agree or with `--use-gh`. That path
reads the committed rulesets and workflows within limits and through no
link, and checks each ruleset has the fields it uses. Each governance
checkpoint becomes a finding. A repository GitHub refuses to
show is inaccessible, and any other failure is unknown; the local
assessment is still reported. `--repo` and `--use-gh` are refused without
`--live`.

Verification: test

## ADOPT-001 Adopting proposes what the project is, from what it holds

`liftoff adopt` brings an existing project under Liftoff: the root of a Git
repository, or another directory named with `--dir`. It refuses the root of
the file system and the home directory, a project Liftoff already has (one
with `liftoff.yaml` or `.liftoff/manifest.json`), and a project with a
change that has not finished (CHANGE-003). It reads the project as
`liftoff assess` does (ASSESS-001 and ASSESS-002), running nothing, and
proposes:

- each part this release supports that it finds, and the directory it is
  in, bound in `liftoff.yaml` when it is not the standard one (PROJ-024):
  the backend's stack, a Vue frontend and Azure infrastructure;
- the coding-agent hosts the project is set up for;
- for a project from a Liftoff release before the rebuild, the name, agents,
  governance profile, GenAI pattern and environments its old configuration
  names, each only when this release has exactly that value (and at least
  one environment);
- otherwise a name made from the directory's name, and the default
  governance profile.

The options `--name`, `--stack`, `--pattern`, `--frontend`,
`--infrastructure`, `--environments`, `--agents`, `--governance`,
`--ai-review`, `--review-engine`, `--owners` and `--layout`, which takes
`part=directory` pairs, replace what it proposes, and the proposal says
where each choice came from. The workflow is `manual`: adopting runs no
framework's initializer, and OpenSpec or Spec Kit files the project has
stay its own.

- Given a repository with a FastAPI application at its root, when it is
  adopted, then the backend is bound to `.` and its stack is
  `python-fastapi`.

Verification: test

## ADOPT-002 A part it cannot place blocks adopting

An option that names something this release does not have, or that other
options given with it rule out, such as an unknown agent, `--review-engine`
for a host `--agents` does not select, or `--environments` with
`--infrastructure none`, is refused as a usage error (exit 2), checked
before anything about the project. One that only the proposal rules out is
refused as a usage error too, once the project's parts are placed. Otherwise adopting changes nothing, names
each reason and exits 3 when:

- more than one directory holds a part of one kind (name one with
  `--layout`), one directory holds two backends of different stacks (name
  one with `--stack`), or a part named with an option or `--layout` is not
  where it is named;
- it could not tell what a directory holds, because a declaration could not
  be read or parsed, or part of the project was not walked, unless
  `--layout` names every part (or `--frontend none` and
  `--infrastructure none` leave them out);
- the parts' directories cannot be bound (PROJ-024), such as one inside
  another, which only moving a part resolves;
- the backend's stack cannot have a frontend or infrastructure found beside
  it, such as a Vue frontend beside a PydanticAI backend: it says to leave
  that part out with `--frontend none` or `--infrastructure none`;
- the directory's name makes no project name and `--name` gives none;
- a declaration a part was found from is not UTF-8 text, so what was read
  is not what is there;
- a record from a Liftoff release before the rebuild is unsupported
  (LEGACY-002), or is an update or repair that release did not finish
  (LEGACY-001).

When no backend this release supports is found, it exits 6. It never puts a
starter application in place of a part it cannot place. Applications this
release has no stack for, beside the parts it adopts, stay the project's
and are named.

Verification: test

## ADOPT-003 Adopting adds Liftoff's own files, never over the project's

The plan (CHANGE-001) adds `liftoff.yaml`, `.liftoff/manifest.json` and
Liftoff's own files for the project (PROJ-026), and changes no file the
project has. Where one of Liftoff's files would go and something already
is, or may be (a file, a directory, a link, a name in other letter case, or
a path through a directory closed to this user), it is not added and is
named; the manifest lists that path as kept, so `liftoff update` never
offers Liftoff's file there (UPDATE-003). A file the project had is never
recorded as Liftoff's, even when it is the same as Liftoff's. The manifest
lists only the files adopting added, and the adoption in its history.

The plan also lists, separately, the application changes the standard
expects of the parts it adopts, which adopting does not make: what
`liftoff assess` finds missing in them, such as a lock file, tests or a
coverage threshold, the lines Liftoff's `.gitignore` has for its own
records when the project keeps its own `.gitignore` and it does not list
them (with or without a leading `/`), or ignores all of `.liftoff` or the
manifest, which every clone needs, and each
infrastructure root module, with a lock file or without, outside the
`bootstrap` directory and the directories under `environments`, the ones
Liftoff's CI validates, or those directories missing. They are the person's to make, for example with a reviewed patch
and `liftoff repair --patch` once the project is adopted.

The change rests on the declarations the proposal was made from, and on the
old records the manifest records, exactly as the assessment read them: if
any of them changed after it was read, planning refuses, and if one changes
before the adoption applies, nothing changes (CHANGE-002).

- Given a project with its own `AGENTS.md`, when it is adopted, then its
  `AGENTS.md` is unchanged, the manifest lists it as kept, and
  `liftoff update` does not offer Liftoff's.

Verification: test

## ADOPT-004 Records from before the rebuild stay the project's, byte for byte

Adopting a project from a Liftoff release before the rebuild changes none
of the old records: they stay the project's own and are never counted as
current configuration or proof. The manifest's legacy record (PROJ-025)
lists the old release and each record's path, kind, state and format, with
the sha256 of the old manifest, configuration and activation state as they
were kept. Records that can hold copies of files, credentials or state are
listed by name alone, never read or hashed (LEGACY-003).

- Given a project from 0.12.3, when it is adopted, then its old manifest
  and configuration are byte for byte as they were, and the manifest
  records their sha256.

Verification: test

## ADOPT-005 Adopting previews, saves and applies exactly what was approved

`liftoff adopt --check` writes nothing, shows the proposal and the plan, and
exits 3 when the project cannot be adopted as it is (6 when it has no
backend this release supports), 0 otherwise. `--out <file>` saves the plan
and changes nothing; `--plan <file>` applies exactly that plan, planned
again from the configuration it holds and refused unless it is the same
plan, made by this release, resting on the same declarations: one edited
since, even keeping its stack, refuses it. Otherwise adopting shows the proposal and the
plan and asks; the default answer is no, and without a terminal it needs
`--yes`. Files change as CHANGE-002 to CHANGE-004 say, with `liftoff.yaml`
and the manifest last. An adoption that stops part way, even before
`liftoff.yaml` is written, exits 5, `liftoff validate` reports it, and
`liftoff adopt --recover finish` or `--recover undo` finishes or undoes it
after asking. Ctrl+C before any file changes exits 4.

Once adopted, `liftoff update` and `liftoff repair` change Liftoff's files
where the project's parts live, and never offer or put back an
application's files (UPDATE-002).

Verification: test

## UPDATE-001 Update changes only the files Liftoff manages

`liftoff update` brings the files `.liftoff/manifest.json` lists as managed
to what this release makes for the project's configuration. For each one
this release changes:

- if it is as Liftoff last wrote it, by its sha256 in the manifest, it is
  replaced, or removed when this release no longer makes it;
- if it is already as this release makes it, or already gone when this
  release no longer makes it, only the manifest changes;
- otherwise, changed by hand, missing, a directory, a link, closed to this
  user or over 64 MiB, it is left as it is and named, with why, and its
  entry in the manifest stays as it was.

Names are compared as macOS and Windows compare them, ignoring letter case
and how an accented letter is encoded, so a managed file this release names
in other letter case is held back for the person to rename, never removed.
Once its name on disk is the one this release uses, it is updated, and
recorded, under that name.

Files the project owns, such as its source, lock files, environment files,
infrastructure and `README.md`, files a framework owns, and `liftoff.yaml`
are never changed, whatever this release makes or the manifest says of
them, and no file changes owner:
a managed file this release makes as the project's is left as it is. The
manifest changes last, with this release's plugin versions and an `update`
in its history; who generated the project stays as it was.

- Given a project made by an earlier release, when it is updated, then each
  managed file still as Liftoff wrote it takes this release's version, and
  a managed file changed by hand is left as it is and named.
- Given a seeded file whose template changed, when the project is updated,
  then it is not changed.

Verification: test

## UPDATE-002 Update never switches what the project is made of

An update applies this release to the configuration the project was made
with. It refuses, changing nothing, when:

- `liftoff.yaml` changed since Liftoff last wrote it, by its sha256 in the
  manifest, since that would also apply the change, including after the
  plan was made and before it applies (CHANGE-002);
- this release would make the project from other plugins than the manifest
  lists, so it never switches the workflow, governance profile, stack,
  pattern, agents or any other plugin;
- a change to the project has not finished (CHANGE-003);
- `liftoff.yaml` or the manifest is missing, invalid, or not a regular file
  Liftoff can read, or the manifest would be over the 1 MiB Liftoff reads
  once updated;
- the project was made by a release before the rebuild and not yet adopted
  (ADOPT-004), or Liftoff made it but `liftoff.yaml` binds parts to other
  directories (PROJ-024) (exit 6).

For a project Liftoff adopted, whose manifest's history begins with the
adoption, this release makes only its own files, where the project's parts
live (PROJ-026), so an update never offers an application's files, and a
repair never puts one back.

Verification: test

## UPDATE-003 New files are added only when chosen

A file this release makes that the manifest does not list, comparing names
as macOS and Windows do, is offered, never added by itself. It is added only
when chosen at a question, where none is chosen by default, or named with
`--add`; `--add` names only offered files. A new file is never added where
something already is, or may be: a file, a directory, a link, or a path
through a directory closed to this user. That path is named and left as it
is. A path the manifest lists as kept, where an adopted project had its own
file (ADOPT-003), is never offered.

Verification: test

## UPDATE-004 Update checks, previews and applies exactly what was approved

`liftoff update --check` writes nothing, so it does not go with `--out`, and
exits 3 when this release has
something for the project: a change, a file held back, a new file offered,
or a new file it could not add; otherwise it exits 0, and only then does it
say the project is up to date. `--out <file>` saves the plan (CHANGE-001)
and changes nothing. Otherwise update shows the plan and asks before
changing anything; the default answer is no, and without a terminal it needs
`--yes`. `--plan <file>` applies exactly a saved plan: the update is planned
again, with the same new files, and refused unless it is the same plan, made
by this release. The files change as CHANGE-002 to CHANGE-004 say; an update
that stops part way exits 5, and `liftoff update --recover finish` or
`--recover undo` finishes or undoes it after asking. A recovery that stops
part way also exits 5, keeping the journal so it can be run again. Recovery
acts only on the interrupted update it showed when it asked: if another
change stopped meanwhile, it refuses and changes nothing. Cancelled with
Ctrl+C before any file changes, an update or a recovery exits 4; after, 5.
An update exits 3 when files were held back, new files could not be added,
or something could not be removed once every file had changed, and 0
otherwise.

- Given a saved plan, when a file it changes is edited before it is
  applied, then it is refused and nothing changes.
- Given an update that stopped part way, when it is recovered, then each
  file is finished or undone and the journal is removed.

Verification: test

## REPAIR-001 Repair lists what needs attention, changing nothing

`liftoff repair --check` lists each file Liftoff wrote that is not as it
should be: a file the manifest lists as managed that is missing, changed by
hand, or something else where it should be, and a file Liftoff wrote for the
project that is missing. A file the project changed is the project's, and
framework files are the framework's, so neither is listed. Each listed file
says what is wrong and whether a recipe can put it back, and why not when no
recipe can. It writes nothing anywhere and exits 3 when a file Liftoff
manages is listed, 0 otherwise: a missing file Liftoff wrote for the
project is listed too, but may have been removed on purpose, so it does
not change the exit code.

Verification: test

## REPAIR-002 Recipes put back files Liftoff wrote, only those chosen

Repair puts back a file only when it is chosen at a question, where none is
chosen by default, or named with `--restore`, which names only files it can
put back:

- a managed file that is missing or was changed by hand is put back as this
  release makes it; one that already is, though the manifest records another
  version, is listed with no recipe, since recording a release's version is
  what `liftoff update` does;
- a file Liftoff wrote for the project that is missing is put back only when
  this release makes it exactly as Liftoff first wrote it.

It never replaces a directory, a link or a file it cannot read, never puts
back a file this release no longer makes, names in other letter case or
gives another owner, and never changes `liftoff.yaml`. The manifest records
each file put back, and the repair in its history. Like an update
(UPDATE-002), it refuses a changed `liftoff.yaml`, another set of plugins, a
change that has not finished, and projects this release cannot update.

- Given a managed file that was deleted and one changed by hand, when only
  the deleted one is chosen, then it is put back and the other is left as
  it is.

Verification: test

## REPAIR-003 A reviewed patch changes only the project's own files, within the paths named

`liftoff repair --patch <file> --paths <paths>` applies a unified diff, as
`git diff --no-renames` writes it, such as one a coding agent prepared and
the person reviewed. It is refused, changing nothing, when:

- it changes a file outside the files and directories named with `--paths`,
  compared as macOS and Windows compare names;
- it changes a file the manifest lists as managed or as a framework's,
  `liftoff.yaml`, anything in `.liftoff`, a `.git` directory, or a path not
  every system can hold;
- a hunk does not match the file exactly at the line it names; no hunk is
  moved or applied loosely;
- it renames, copies or changes the mode of a file, changes a binary file,
  names a file twice, names a file in quotes, or makes one path both a file
  and a directory of other files;
- it holds more than one commit, as `git format-patch` writes several, or is
  not UTF-8 text;
- a file it changes or removes is missing, not UTF-8 text, larger than
  4 MiB, or a link; a file it adds already exists;
- the patch itself is larger than 4 MiB.

Blank lines after its last hunk are ignored. A file it adds may be made
executable; a file it changes keeps its mode. The manifest records the
repair in its history and is otherwise unchanged; a file Liftoff wrote for
the project that the patch removes is then listed, as one that may have
been removed on purpose.

- Given a patch made with `git diff` against the project, when it is
  applied within its paths, then each file is exactly what Git would make.
- Given a patch that also changes a managed file, then nothing changes.

Verification: test

## REPAIR-004 Repair previews, saves and applies exactly what was approved

A repair shows its plan and asks before changing anything; the default
answer is no, and without a terminal it needs `--yes`. `--out <file>`
saves the plan and changes nothing; `--plan <file>` applies exactly that
plan, planned again (with the same `--patch` and `--paths` for a patch) and
refused unless it is the same plan, made by this release. `--check` goes
without `--restore` and `--patch`. Files change as CHANGE-002 to CHANGE-004
say; a repair that stops part way exits 5, `liftoff repair --recover finish`
or `--recover undo` finishes or undoes it after asking, and Ctrl+C before
any file changes exits 4. A repair exits 3 when files Liftoff manages still
need attention or something could not be removed afterwards, and 0
otherwise; after a patch, which looks at no other file, it does not say
whether any still need attention.

Verification: test

## MIGRATE-001 Migrating makes a new project beside the old one, and never changes the old one

`liftoff migrate` makes a new Liftoff project from an existing one: the
root of a Git repository, or another directory named with `--dir`. It
refuses the root of the file system and the home directory, a project
Liftoff already has (one with `liftoff.yaml` or `.liftoff/manifest.json`),
and a project with a change that has not finished (CHANGE-003). The new
project goes in a new or empty directory named with `--to`, by default the
old project's directory name followed by `-liftoff`, beside it. The
directory it goes in must exist. The new project's directory may not be the
old project, be inside it or hold it, compared as macOS and Windows compare
names once each link in either path is followed (a name that only starts
with two dots, such as `..next`, is inside), and may not be the current
directory or hold it. When a saved plan is applied, and again just before
the new project is made, no link may lead either directory elsewhere.
`--out` may not save a plan in either, or write through a link.

Migrating writes nothing into the old project: no file, lock or record. It
reads the project as `liftoff assess` does (ASSESS-001 and ASSESS-002),
plus each file it copies (MIGRATE-002), and runs nothing.

It proposes the new project's configuration as `liftoff adopt` does
(ADOPT-001), from the parts it finds wherever they are. The same options
replace any choice, except `--layout`, since the new project has the
standard layout. Its workflow is `manual`. `--stack` may name a stack the
old project has no backend on, to move the application to it. The new
project is the one `liftoff init` makes with that configuration, starter
application included, with `migrate` first in its manifest's history. It
also holds the copy and `MIGRATION.md`.

An option mistake is refused before anything about the project, as for
adopting (ADOPT-002), and exits 2. Otherwise migrating creates nothing,
names each reason and exits 3 when:

- no backend this release supports is found and `--stack` names none, or
  backends on more than one stack are found and `--stack` picks none of
  them;
- it could not tell what a directory holds, because a declaration could
  not be read or parsed, unless `--stack`, `--frontend` and
  `--infrastructure` are all given;
- part of the project was not walked or a file in it cannot be read,
  because it is closed to this user, changed while it was listed or is past
  a limit, so the copy would miss it;
- the stack cannot have a frontend or infrastructure found in the project:
  it says to leave that part out with `--frontend none` or
  `--infrastructure none`;
- the directory's name makes no project name and `--name` gives none;
- a declaration a part was found from is not UTF-8 text, so what was read
  is not what is there;
- a record from a Liftoff release before the rebuild is unsupported
  (LEGACY-002), or is an update or repair that release did not finish
  (LEGACY-001);
- what it would copy is over 1 GiB together.

Planning refuses a declaration a part was found from that changed after it
was read, so the proposal, the checklist and the copy describe the same
project. Ctrl+C while planning, even with `--check`, exits 4.

- Given a FastAPI project, when it is migrated, then the new project has a
  `python-fastapi` backend in `backend/`, and no file in the old project
  changed.

Verification: test

## MIGRATE-002 The copy leaves out secrets, dependencies, caches, state and build output

The new project holds a copy of the old project's files in `legacy/`, each
at the same path within it and with its permissions. On macOS, `legacy/`
itself is open only to the person, since the old project's own directories
may have been closed to others; on Windows it has the access the directory
it is in gives new directories. It copies every regular file the walk
reaches, except:

- Git's data, a `.git` directory or file at any depth, and the
  directories the walk does not enter because of their names, which usually
  hold installed dependencies, caches or build output (ASSESS-002);
- files that may hold secrets or state, which `liftoff assess` lists as not
  read (ASSESS-001), including a SQLite database's journal, write-ahead log
  and shared memory;
- the records a Liftoff release before the rebuild left (LEGACY-001), which
  stay with the old project as its history;
- links and special files, which are never followed;
- a file over 64 MiB;
- a path not every system can hold (CHANGE-001), or one that macOS and
  Windows take for another the copy holds: the same file, a file and a
  directory, or two spellings of one directory.

Each file or directory left out is named, with why, in what migrating
shows, its `--json` report and `MIGRATION.md`, whose hash the plan holds. The plan lists each copied file with its sha256 and size. A
file changed since the plan was made makes the plan stale, and it is
refused; a file that changes while it is being copied stops the migration
before anything is created.

- Given a project with `.env`, `node_modules` and `dist`, when it is
  migrated, then none of them is in `legacy/`, and `MIGRATION.md` names
  each.

Verification: test

## MIGRATE-003 A checklist says what to move, and the new project is checked

The new project's `MIGRATION.md` is the project's own: the manifest does
not list it. It lists, as steps to tick off:

- each part found, where it is in `legacy/`, and where the new project
  keeps that part, with what each of its directories is for;
- the parts the new project has no place for: applications this release
  has no stack for, and a second part of a kind the new project has one of;
- what the copy left out, and what to do about it: recreate secrets and
  state outside Git, install dependencies again, and leave the records from
  before the rebuild with the old project;
- the old project's workflows and coding-agent instructions, to compare
  with Liftoff's;
- how to check the result, with `liftoff validate` and the project's own
  tests;
- cleaning up the old project with `liftoff migrate --cleanup`
  (MIGRATE-004) before deleting the copy;
- deleting `legacy/` and `MIGRATION.md` once done.

Names from the old project, such as file names and stacks, are written with
control characters and characters that change the direction of text
escaped, so none can add a step or a heading of its own. The old project
and its Git history stay where they are.

`liftoff migrate --check` writes nothing, shows the proposal and the plan,
and exits 3 when the project cannot be migrated as it is, and 0 otherwise.
`--out <file>` saves the plan and creates nothing. `--plan <file>` applies
exactly that plan. It is planned again from what the plan holds, and
refused unless it is the same plan, made by this release, for files still
as they were. Otherwise migrating shows the proposal and the plan, and asks;
the default answer is no, and without a terminal it needs `--yes`.

The new project is written beside its directory and moved into place in one
step, so it is there whole or not at all. Just before that, the old project
is planned again and must give the same plan, so a file that changed after
it was copied, or one that appeared, means nothing is created. Ctrl+C
before then leaves nothing and exits 4. Once it is in place, each of its files is read back and
compared with the plan, and it is validated as `liftoff validate` does.
Anything different is named, and the command exits 3.

Verification: test

## MIGRATE-004 Cleaning up the old project is a separate step that asks first

Migrating never removes anything from the old project. `liftoff migrate
--cleanup` does, as a step of its own, once the new project is verified,
and only after asking: the default answer is no, and without a terminal it
needs `--yes`. It takes the old project from `--dir` and the new one from
`--to`, by default as migrating does (MIGRATE-001).

Both projects must be directories that are there, may not overlap, and no
link may lead either elsewhere (MIGRATE-001); the old project may not be a
Liftoff project or have a change that has not finished. Otherwise the
command refuses, removes nothing and exits 1. The new project is then
verified: it must be a Liftoff project whose manifest's history starts
with `migrate`, and `liftoff validate` must find no error in it. Until it
is, nothing is removed, each reason is named, and the command exits 3.

A file of the old project is removed only when migrating would copy it
(MIGRATE-002) and a file with the same sha256 is somewhere the walk of the
new project reaches (ASSESS-002), such as its copy in `legacy/` or a file
moved from there unchanged. Everything else stays and is named, with why:

- Git's data;
- files that may hold secrets or state;
- records from a Liftoff release before the rebuild;
- links;
- files over 64 MiB;
- paths not every system can hold;
- files the new project holds no copy of, such as one changed since in
  either project.

Directories the cleanup leaves empty are removed, one at a time and only
while empty, and so is the old project's `.liftoff` once nothing is in it.
The old project's own directory always stays.

Files are removed as CHANGE-002 to CHANGE-004 say, in changes of at most
2,000 files each, so each can be finished or undone. Just before each
change, every copy it rests on in the new project is hashed again; if one
changed, that change removes nothing and the command says to run it again.
A cleanup that stops part way exits 5, and `liftoff migrate --cleanup
--recover finish` or `--recover undo` finishes or undoes that change after
asking, and says that any later changes did not run. Finishing removes the
rest of that change's files only while the new project (`--to`) still holds
a copy of each; otherwise it removes nothing, names those without one, says
to undo instead, and exits 3. Ctrl+C between changes stops with the files
of finished changes removed, and exits 4. `--check` shows what would be
removed and what stays, removes nothing, and goes without `--yes`.

- Given a migrated project whose `legacy/` still holds an unchanged copy of
  `app/main.py`, and an old `.env`, when the old project is cleaned up,
  then `app/main.py` is removed from it and `.env` and `.git` stay.

Verification: test
