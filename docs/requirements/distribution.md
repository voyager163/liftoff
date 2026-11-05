# Distribution

How Liftoff itself is packaged, released and installed. Building the bundle
that runs without a global Node is PKG-001 in [repository.md](repository.md).

## DIST-001 One npm package carries every file Liftoff ships

Liftoff is packaged once, as the npm package `@voyager163/liftoff`, and the
native bundles unpack that same package. npm leaves some files out of every
package, `.gitignore` among them, so assets keep each `.gitignore` as
`_gitignore`, and Liftoff reads it under its real name. Packing checks that
every file Git tracks under `assets/` and `.github/liftoff/`, and every built
file, is in the package, and nothing else is.

- Given a template with a `.gitignore`, when Liftoff is installed from the
  npm package or the bundle and generates a project, then the project has that
  `.gitignore`.
- Given an asset that npm would leave out, when the package is packed, then
  packing fails and names the file.
- Given the package installed into an npm prefix, when Liftoff runs from
  outside its checkout, then `--version`, `init` and `validate` work.

npm 12 ships no lockfile in a package, so an npm install gets Liftoff's exact
direct dependencies but resolves theirs afresh. The bundle installs from
Liftoff's lockfile.

Verification: test

## DIST-002 Each bundle says what it is

Every bundle has a `release.json` (`liftoff.release/v1`) with the version,
the platform target, the Node.js version, the source commit and tree, and the
signing identity for each operating system, which is `null` while unsigned.
Nothing in it names a channel: the same artifact serves every channel, and
which channel installed a copy is read from that channel's own records.

- Given a bundle built from a commit, when its `release.json` is read, then
  its commit and tree are that commit's and its version is the package's.
- Given a bundle built without signing, when its `release.json` is read,
  then both signing identities are `null`.

Verification: test
