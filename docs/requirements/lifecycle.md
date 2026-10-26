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
expected. A path outside the project, inside `.git`, named twice (ignoring
case, as macOS and Windows do) or not really changing makes the plan
invalid.

Verification: test

## CHANGE-002 A file changed since the plan is never overwritten

Before anything changes, every file must still be exactly as the plan says:
the same content, a regular file and not a link, or still absent. If any is
not, nothing changes and each such file is named. Each new file's content
must hash to what the plan says. Just before each file is replaced it is
checked again; if it changed meanwhile, it and the files after it are left
alone and the change can be recovered (CHANGE-003).

Verification: test

## CHANGE-003 A change that stops part way can be finished or undone

Before the first file changes, Liftoff keeps a byte-for-byte copy of every
file the change replaces or removes, beside the project, and writes a
journal at `.liftoff/change-journal.json`. Only one change runs at a time.
If a change stops part way, the journal stays and `liftoff validate` reports
it. Recovery then finishes or undoes it, deciding each file from what is
there now:

- a file already as wanted is left alone;
- a file as the change found it (finishing), or as the change left it
  (undoing), is replaced;
- any other file was changed by something else and is never overwritten. It
  is named, and the journal stays until it is resolved.

Verification: test

## CHANGE-004 Files change one at a time, the manifest last

Each file is replaced in one step, keeping the executable bit planned. The
project's files change first, then `liftoff.yaml`, then
`.liftoff/manifest.json`, so the manifest never lists files that were not
written. Once every file has changed, the journal and the kept copies are
removed. A change across several files is not atomic; the journal is how an
interrupted one is recovered.

Verification: test
