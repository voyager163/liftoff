# Azure deployment

Azure infrastructure is generated for GenAI and API workloads that select the
available Azure provider. Power Apps code apps use Power Platform hosting and
do not receive Liftoff-owned OpenTofu.

Liftoff generates infrastructure code but does not authenticate, plan, or apply
it. Review all files and use your organization's delivery controls.

## OpenTofu layout

Generated API projects place Azure modules and environment tfvars under:

```text
infrastructure/opentofu/azure/
```

`liftoff infra` prints the applicable OpenTofu commands; it does not execute
them.

## Globally scoped names

Each environment tfvars file has a deterministic 12-character lowercase
alphanumeric `resource_suffix` for globally scoped Azure names.

If Azure reports a collision, replace that environment's suffix with another
unique value matching:

```text
^[a-z0-9]{12}$
```

Generated validation rejects an invalid override.

## Worker-enabled projects

Worker-enabled GenAI projects:

- Configure `ServiceBusConnection__fullyQualifiedNamespace`.
- Configure `ServiceBusConnection__clientId` for the attached user-assigned
  managed identity.
- Grant that identity's principal the Azure Service Bus Data Receiver role.
- Use `function_worker_queue_name` for the provisioned queue, Function setting,
  and output.

Function host storage uses one complete key-backed `AzureWebJobsStorage`
configuration rather than mixed partial identity settings.

## Frontend origins

Generated backends allow their local frontend origin by default. When
`VITE_API_BASE_URL` points to a frontend on another origin, set the
comma-separated `CORS_ALLOWED_ORIGINS` value. Generated Azure infrastructure
sets it to the deployed frontend URL.

## Deployment boundary

Before applying infrastructure:

1. Run `liftoff validate` and `liftoff doctor`.
2. Install and verify OpenTofu separately.
3. Authenticate with Azure under the intended tenant and subscription.
4. Review tfvars, names, role assignments, networking, and state storage.
5. Run plan through your normal review process.

Liftoff never stores Azure credentials or signs in on your behalf.
