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
the old releases wrote, never in an unrelated repository.

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
