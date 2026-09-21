# Pinned provider default controls

The local Checkov preview separately reports exact source-control equivalence
for these independently qualified generated-baseline omissions:

| Native rule | Exact resource attribute | AzureRM 5.3.0 default |
| --- | --- | --- |
| CKV_AZURE_44 | Storage `min_tls_version` | `TLS1_2` |
| CKV_AZURE_148 | Redis `minimum_tls_version` | `1.2` |
| CKV_AZURE_190 | Storage `allow_nested_items_to_be_public` | `false` |
| CKV_AZURE_205 | Service Bus `minimum_tls_version` | `1.2` |

These remain security controls, not optional-feature diagnostics or vulnerability
exceptions. Native failed observations, counts and locations remain unchanged.
The separate `satisfied-by-pinned-provider-default` classification binds the
actual scanner-issued resource result, omitted attribute, exact provider,
registered case/environment input digest, schema and request serialization.
Another resource, telemetry role or changed generator input cannot inherit it.
Explicit weak, null or unresolved values, lifecycle overrides, altered provider
selection and missing or serialized observations do not qualify.

The provenance is pinned to AzureRM commit
`9215c429172fbccf3c7c6197a246d23f7c3287af` and SDK 2.40.1.
Exact resource/constant blobs and schema/create/update line ranges are recorded
in `security/provider-default-control-decision.json`. Storage and Service Bus
updates send these values when the attribute changes; Redis includes its TLS
value in the update request. Source defaults are not proof of existing deployed
state, refreshed remote state or successful infrastructure execution.

Function HTTPS-only, Service Bus local authentication, Key Vault purge
protection, other authentication/exposure controls and actual image
vulnerabilities retain their independent requirements. No infrastructure,
dependency, network, SKU or deployed setting is changed. The preview supplies
neither adopted-policy authority nor PR/release admission.

See the [repository security guide](../repository-security.md) for the wider
qualification and authorization boundaries.
