---
name: liftoff-assess
description: "Read-only inspection and assessment of existing codebase, standards conformance, and stack compatibility."
---

# Liftoff Project Assessment Workflow

## Capability Negotiation

```bash
liftoff capabilities --json
```

Require `standards-assessment`, owned by Standards and Assessment, with public
envelope schema 1 and command result schema 1. Distinguish implementation,
qualification, prerequisite and unsupported-profile limits. Metadata alone is
not host/provider qualification or application safety.

## Read-Only Project Inspection

Select the real directory or explicit component boundary. No Git repository,
manifest, initialization, project script or provider mutation is a prerequisite.

```bash
liftoff assess --project ./my-app --json
liftoff assess --project ./my-app
```

Use only actual installed profile IDs when explicit selection is needed.
Assessment inventories evidence; it never creates a manifest, stages a patch,
claims ownership of business files, or rewrites a project to match a starter.
No model client or model credentials are required by deterministic inspection.

## Explain Coverage and Preserve Context

Keep observed facts, missing observations, unsupported rules, conflicts,
differences and verified outcomes distinct. A comment, filename, model assertion
or byte-identical starter file does not prove conformance or grant ownership.
Do not describe unexecuted tests, Checkov, OpenTofu, network probes or provider
checks as performed because the assessment mentions those areas.

Preserve actual `nextActions`: executable, literal argument array, cwd, scope,
project/component boundary, original configuration path/digest, compatibility and
authority. Do not execute recommendations automatically or invent command names
from capability IDs. Unsupported or retired workloads stay diagnostic-only;
fresh-target migration is not an automatic semantic conversion.

Use the actual result's outcome and coverage with its declared 0/1/2 exit
semantics. A successful check is not full application, native-host or provider
qualification. Report gaps instead of manufacturing a complete journey.
