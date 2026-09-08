import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'functionsRequirements'>;
import type { AddArtifact } from '../../template-types.js';
import { DEFAULT_FUNCTION_WORKER_QUEUE_NAME } from '../common/values.js';
import { functionWorkerName } from '../common/values.js';
import { genAiPattern } from '../common/values.js';
import type { GenAiProjectPlan } from '../../domain/project/contracts.js';
import { hasFunctionWorker } from '../common/values.js';
import { pyModule } from '../common/values.js';


export function addFunctionArtifacts(add: AddArtifact, plan: GenAiProjectPlan, context: GeneratorContext): void {
  if (!hasFunctionWorker(plan)) {
    return;
  }

  const workerName = functionWorkerName(plan);
  const workerBase = ['functions', workerName];
  add('functions-readme', 'functions', ['functions', 'README.md'], renderFunctionsReadme());
  add('function-worker-readme', 'functions', [...workerBase, 'README.md'], renderFunctionWorkerReadme(plan));
  add('function-worker-host', 'functions', [...workerBase, 'host.json'], renderFunctionHostJson());
  add('function-worker-local-settings', 'functions', [...workerBase, 'local.settings.example.json'], renderFunctionLocalSettings(plan));
  add('function-worker-requirements', 'functions', [...workerBase, 'requirements.txt'], renderFunctionRequirements(context));
  add('function-worker-app', 'functions', [...workerBase, 'function_app.py'], renderFunctionApp(plan));
  add('function-worker-test', 'functions-test', [...workerBase, 'tests', 'test_function_app.py'], renderFunctionTest());
  add('function-worker-funcignore', 'functions', [...workerBase, '.funcignore'], renderFunctionFuncIgnore());
  add('function-worker-gitignore', 'functions', [...workerBase, '.gitignore'], renderFunctionGitIgnore());
}

export function renderFunctionsReadme(): string {
  return `# Azure Functions Workers

Azure Functions trigger adapters live under \`functions/<worker-name>\`.

Keep reusable GenAI orchestration, model configuration, prompt handling, and domain logic under \`backend/orchestration\`. Use \`backend/workers\` for backend-adjacent or containerized workers; use this folder for Azure Functions runtime files such as \`host.json\`, trigger bindings, local settings, and Function app tests.
`;
}

export function renderFunctionWorkerReadme(plan: GenAiProjectPlan): string {
  const workerName = functionWorkerName(plan);
  const pattern = genAiPattern(plan);
  return `# ${workerName}

Azure Functions worker scaffold for ${pattern.label}.

This Function app uses the Python v2 decorator programming model and a Service Bus queue trigger. The trigger adapter should stay thin: decode the message, validate the envelope, and call shared code from \`backend/orchestration\` after that shared code is packaged with the Function app.

The generated trigger currently decodes and logs message keys, then returns. It does not index documents,
invoke orchestration, or execute workflow stages. A successfully published message is not proof of
completed processing; implement and test a real consumer before using this scaffold for production work.

Deployed triggers use \`ServiceBusConnection__fullyQualifiedNamespace\` and \`ServiceBusConnection__clientId\` to select the same user-assigned identity that OpenTofu grants the Service Bus Data Receiver role. \`SERVICEBUS_QUEUE_NAME\` is populated from \`function_worker_queue_name\`. Function host storage uses the complete \`AzureWebJobsStorage\` connection setting.

## Local Development

\`\`\`bash
uv sync --frozen --project ../../backend --extra test --extra functions
cp local.settings.example.json local.settings.json
uv run --project ../../backend --directory . python -m pytest -q
func start
\`\`\`
`;
}

export function renderFunctionHostJson(): string {
  return JSON.stringify({
    version: '2.0',
    extensionBundle: {
      id: 'Microsoft.Azure.Functions.ExtensionBundle',
      version: '[4.*, 5.0.0)'
    }
  }, null, 2);
}

export function renderFunctionLocalSettings(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  return JSON.stringify({
    IsEncrypted: false,
    Values: {
      AzureWebJobsStorage: 'UseDevelopmentStorage=true',
      FUNCTIONS_WORKER_RUNTIME: 'python',
      SERVICEBUS_QUEUE_NAME: DEFAULT_FUNCTION_WORKER_QUEUE_NAME,
      ServiceBusConnection__fullyQualifiedNamespace: '<service-bus-namespace>.servicebus.windows.net',
      GENAI_PATTERN: pattern.id,
      SHARED_ORCHESTRATION_ROOT: '../../backend'
    }
  }, null, 2);
}

export function renderFunctionRequirements(context: GeneratorContext): string {
  return context.functionsRequirements;
}

export function renderFunctionApp(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  return `import json
import logging

import azure.functions as func


app = func.FunctionApp()


def decode_message_payload(body: str) -> dict:
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}
    if isinstance(value, dict):
        return value
    return {"value": value}


@app.service_bus_queue_trigger(
    arg_name="message",
    queue_name="%SERVICEBUS_QUEUE_NAME%",
    connection="ServiceBusConnection",
)
def process_${moduleName}_work(message: func.ServiceBusMessage) -> None:
    payload = decode_message_payload(message.get_body().decode("utf-8"))
    logging.info("Received ${pattern.id} worker message with keys: %s", sorted(payload.keys()))
    # Keep this adapter thin; call backend.orchestration code from packaged shared modules.
`;
}

export function renderFunctionTest(): string {
  return `from function_app import decode_message_payload


def test_decode_message_payload_for_json_object():
    assert decode_message_payload('{"source_uri":"az://documents/example.pdf"}') == {
        "source_uri": "az://documents/example.pdf"
    }


def test_decode_message_payload_for_plain_text():
    assert decode_message_payload("plain text") == {"raw": "plain text"}
`;
}

export function renderFunctionFuncIgnore(): string {
  return `.venv/
node_modules/
dist/
build/
.git/
.liftoff/
.terraform/
__pycache__/
.pytest_cache/
.env
.env.*
*.env
*.pem
*.key
*.pfx
*.tfstate*
local.settings.json
tests/
`;
}

export function renderFunctionGitIgnore(): string {
  return `.venv/
__pycache__/
.pytest_cache/
local.settings.json
`;
}
