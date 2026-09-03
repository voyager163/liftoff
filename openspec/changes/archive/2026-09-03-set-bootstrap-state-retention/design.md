## Context

See `proposal.md` for motivation. Policy v3 requires repository-owned private
remote state before ordinary infrastructure work, but a storage account with
public network access disabled cannot be reached until private networking and a
permitted execution environment exist. Liftoff's infrastructure contract
already allows local initialization; the missing contract is how that transient
state is constrained, adopted remotely, retained, and destroyed.

## Goals / Non-Goals

**Goals:**

- Resolve the private-backend bootstrap cycle without enabling public storage
  access or transferring sensitive state through GitHub.
- Define objective evidence for the transition from local bootstrap to remote
  state.
- Set one deterministic retention period and disposal record.
- Preserve fail-closed phase boundaries and repository subscription ownership.

**Non-Goals:**

- Make local state an acceptable long-term backend.
- Add state migration or cloud provisioning commands to the Liftoff CLI.
- Require a local bootstrap when an approved private management path already
  exists.
- Prescribe a platform-specific secure-delete command that cannot be guaranteed
  across filesystems and operating systems.

## Decisions

### Prefer an existing private execution path

Phase 0 first discovers whether an approved VPN, private management runner, or
other repository-owned environment can reach the private backend. If so, remote
state is initialized there and no local bootstrap is created.

Creating a new permanent management network by default was rejected because it
adds cost and lifecycle scope merely to avoid a transient bootstrap.

### Permit only a minimum, explicitly approved local bootstrap

When no private path exists, the downstream governance change may use local
OpenTofu state for only the resources needed to establish private backend
access: the repository-owned network, selected egress, inbound controls,
storage private endpoint and DNS, network setting, and restricted execution
runner. The phase remains `bootstrap-local`; it is neither `remote-ready` nor
permission for application provisioning.

Local state is encrypted at rest on the approved workstation, gitignored,
single-writer, and never copied through GitHub artifacts, repository secrets, or
ordinary messaging. The plan records every resource ID and the state checksum
without exposing state content.

Immediate deletion was rejected because remote adoption can reveal delayed
identity or drift problems. Indefinite retention was rejected because it leaves
a second sensitive control record and invites accidental reuse.

### Adopt resources through declarative remote import

Once the restricted VNet runner can resolve and reach the private Blob endpoint,
it initializes empty ZRS backends and uses reviewed import declarations to adopt
the existing bootstrap resources. The local state file is not transferred to
the runner.

Remote adoption is verified only when:

- private DNS and authenticated backend access succeed from the exact runner;
- every expected live resource ID exists once in remote state;
- state locking and Blob versioning are active;
- a clean checkout initializes the remote backend; and
- `tofu plan -detailed-exitcode` reports no create, update, or destroy action.

Using `init -migrate-state` through an ordinary state-file transfer was rejected
because the transport would create another sensitive copy and weaken custody.

### Start one 30-day evidence-retention clock

The remote-import verification record supplies the single retention start
timestamp. At that transition the local backend is frozen read-only and all
future plan/apply entry points use remote state. Failed or incomplete
verification starts no clock and permits no deletion.

The fixed duration is **30 days**. It provides a bounded recovery and audit
window while preventing indefinite duplicate state. The value is a settled
policy default rather than a repository prompt.

### Securely delete and record the outcome

At expiry, the operator removes the encrypted local state and every approved
temporary copy using the platform's supported secure-disposal procedure. Since
copy-on-write filesystems and SSD wear leveling can make overwrite claims
unverifiable, the normative outcome is destruction of the encryption key and
removal of the encrypted files, with device-management evidence where
available.

The deletion record contains the repository, state identity/checksum,
remote-import evidence reference and timestamp, scheduled and actual deletion
timestamps, operator, method, and outcome. It contains no state payload,
credentials, or secret outputs.

### Advance the managed policy contract

The canonical policy version advances from 3 to 4. Required fragments cover
minimum local scope, encrypted single-writer custody, prohibited transfers,
remote-import parity, no-change verification, the 30-day read-only period, and
secure deletion evidence. Existing projects receive the new contract only
through reviewed managed-core update.

## Risks / Trade-offs

- **[Retained state is a second sensitive copy]** -> Encrypt it, freeze it
  read-only, limit custody, prohibit transfers, and enforce fixed deletion.
- **[Secure overwrite is unreliable on modern storage]** -> Destroy encryption
  keys and remove encrypted copies instead of claiming guaranteed sector
  overwrite.
- **[A false verification starts retention too early]** -> Require private
  access, identity parity, locking, versioning, and a clean no-change plan.
- **[Operators accidentally reuse retained state]** -> Remove local apply entry
  points and treat the copy as evidence-only immediately after verification.
- **[Policy-version drift blocks downstream work]** -> Preserve normal
  managed-core review and historical manifest compatibility.

## Migration Plan

1. Advance the canonical policy and validator to version 4.
2. Update main behavior tests, generated metadata, hashes, snapshots, and public
   governance documentation.
3. Validate OpenSpec and run the focused and complete package gates.
4. Existing projects review policy-v4 managed-core drift before changing their
   bootstrap plan.
5. Roll back by restoring policy version 3 and its validator, tests, hashes, and
   documentation together; no live state is changed by the Liftoff rollback.
