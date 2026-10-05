import type { PluginRegistryInput } from '../contracts.js';
import { deepFrozen } from './core.js';

// Actual captured source declarations, not current target declarations or execution permission.
export const modernPreAssessmentSourceRevision = "cdd9efaca785842e6f09110f22cc23f052bf92d3";
export const modernPreAssessmentDeclarationsDigest = "sha256:086953fe16b5f03121d50a62ce5abf47ffe159f5606723781abb4eb958181301";
export const modernPreAssessmentSource = deepFrozen({
  "descriptors": [
    {
      "category": "stack",
      "id": "python-fastapi",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {
          "workload": [
            "standard"
          ]
        },
        {
          "workload": [
            "genai"
          ]
        }
      ],
      "artifacts": [
        {
          "logicalName": "backend-pyproject",
          "category": "backend",
          "pathParts": [
            "backend",
            "pyproject.toml"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-uv-lock",
          "category": "backend",
          "pathParts": [
            "backend",
            "uv.lock"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-package",
          "category": "backend",
          "pathParts": [
            "backend",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-api-package",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-main",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "main.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-health-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "health.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-routes-package",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-auth-dependency",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "dependencies",
            "auth.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-config-package",
          "category": "backend",
          "pathParts": [
            "backend",
            "config",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-settings",
          "category": "backend",
          "pathParts": [
            "backend",
            "config",
            "settings.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-observability-package",
          "category": "backend",
          "pathParts": [
            "backend",
            "observability",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-test-health",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_health.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-alembic-ini",
          "category": "database",
          "pathParts": [
            "database",
            "alembic.ini"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-alembic-env",
          "category": "database",
          "pathParts": [
            "database",
            "migrations",
            "env.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-initial-migration",
          "category": "database",
          "pathParts": [
            "database",
            "migrations",
            "versions",
            "0001_initial.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-schema",
          "category": "database",
          "pathParts": [
            "database",
            "models",
            "schema.sql"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "backend-observability",
          "category": "backend",
          "pathParts": [
            "backend",
            "observability",
            "logging.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "standard"
            ]
          }
        },
        {
          "logicalName": "backend-observability",
          "category": "backend",
          "pathParts": [
            "backend",
            "observability",
            "tracing.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "backend-orchestration-package",
          "category": "backend",
          "pathParts": [
            "backend",
            "orchestration",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "backend-model-config",
          "category": "backend",
          "pathParts": [
            "backend",
            "orchestration",
            "model_config.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "backend-messaging-tool",
          "category": "backend",
          "pathParts": [
            "backend",
            "orchestration",
            "tools",
            "messaging.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "backend-tools-package",
          "category": "backend",
          "pathParts": [
            "backend",
            "orchestration",
            "tools",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "backend-test-messaging",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_messaging.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "backend-test-tracing",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_tracing.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-package",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt-readme",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "README.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "workload": [
              "genai"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "generic.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "generic"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "generic_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "generic"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_generic_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "generic"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "generic.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "generic"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "rag.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "rag_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_rag_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "rag.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "chatbot.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "chatbot"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "chatbot_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "chatbot"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_chatbot_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "chatbot"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "chatbot.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "chatbot"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "agent_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_agent_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "agent.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "prompt.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "prompt"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "prompt_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "prompt"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_prompt_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "prompt"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "prompt.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "prompt"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "multi_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "multi_agent_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_multi_agent_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "multi-agent.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "fine_tuned.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "fine-tuned"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "fine_tuned_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "fine-tuned"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_fine_tuned_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "fine-tuned"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "fine-tuned.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "fine-tuned"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "streaming.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "streaming"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "streaming_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "streaming"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_streaming_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "streaming"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "streaming.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "streaming"
            ]
          }
        },
        {
          "logicalName": "backend-pattern-routes",
          "category": "backend",
          "pathParts": [
            "backend",
            "apis",
            "routes",
            "workflow.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ]
          }
        },
        {
          "logicalName": "pattern-agent",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "agents",
            "workflow_agent.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ]
          }
        },
        {
          "logicalName": "pattern-agent-test",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "tests",
            "test_workflow_orchestration.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ]
          }
        },
        {
          "logicalName": "pattern-prompt",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "prompts",
            "workflow.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ]
          }
        },
        {
          "logicalName": "rag-vector-store",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "retrieval",
            "vector_store.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ]
          }
        },
        {
          "logicalName": "rag-retrieval-package",
          "category": "pattern",
          "pathParts": [
            "backend",
            "orchestration",
            "retrieval",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ]
          }
        },
        {
          "logicalName": "fine-tuned-eval-dataset",
          "category": "pattern",
          "pathParts": [
            "backend",
            "evaluation",
            "datasets",
            "sample.jsonl"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "fine-tuned"
            ]
          }
        },
        {
          "logicalName": "backend-workers-package",
          "category": "pattern",
          "pathParts": [
            "backend",
            "workers",
            "__init__.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag",
              "agent",
              "multi-agent",
              "workflow"
            ]
          }
        },
        {
          "logicalName": "functions-readme",
          "category": "functions",
          "pathParts": [
            "functions",
            "README.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag",
              "agent",
              "multi-agent",
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "pattern-worker",
          "category": "pattern",
          "pathParts": [
            "backend",
            "workers",
            "rag_worker.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ]
          }
        },
        {
          "logicalName": "function-worker-readme",
          "category": "functions",
          "pathParts": [
            "functions",
            "rag-worker",
            "README.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-host",
          "category": "functions",
          "pathParts": [
            "functions",
            "rag-worker",
            "host.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-local-settings",
          "category": "functions",
          "pathParts": [
            "functions",
            "rag-worker",
            "local.settings.example.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-requirements",
          "category": "functions",
          "pathParts": [
            "functions",
            "rag-worker",
            "requirements.txt"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-app",
          "category": "functions",
          "pathParts": [
            "functions",
            "rag-worker",
            "function_app.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-test",
          "category": "functions-test",
          "pathParts": [
            "functions",
            "rag-worker",
            "tests",
            "test_function_app.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-funcignore",
          "category": "functions",
          "pathParts": [
            "functions",
            "rag-worker",
            ".funcignore"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-gitignore",
          "category": "functions",
          "pathParts": [
            "functions",
            "rag-worker",
            ".gitignore"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "rag"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "pattern-worker",
          "category": "pattern",
          "pathParts": [
            "backend",
            "workers",
            "agent_worker.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ]
          }
        },
        {
          "logicalName": "function-worker-readme",
          "category": "functions",
          "pathParts": [
            "functions",
            "agent-worker",
            "README.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-host",
          "category": "functions",
          "pathParts": [
            "functions",
            "agent-worker",
            "host.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-local-settings",
          "category": "functions",
          "pathParts": [
            "functions",
            "agent-worker",
            "local.settings.example.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-requirements",
          "category": "functions",
          "pathParts": [
            "functions",
            "agent-worker",
            "requirements.txt"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-app",
          "category": "functions",
          "pathParts": [
            "functions",
            "agent-worker",
            "function_app.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-test",
          "category": "functions-test",
          "pathParts": [
            "functions",
            "agent-worker",
            "tests",
            "test_function_app.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-funcignore",
          "category": "functions",
          "pathParts": [
            "functions",
            "agent-worker",
            ".funcignore"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-gitignore",
          "category": "functions",
          "pathParts": [
            "functions",
            "agent-worker",
            ".gitignore"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "pattern-worker",
          "category": "pattern",
          "pathParts": [
            "backend",
            "workers",
            "multi_agent_worker.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ]
          }
        },
        {
          "logicalName": "function-worker-readme",
          "category": "functions",
          "pathParts": [
            "functions",
            "multi-agent-worker",
            "README.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-host",
          "category": "functions",
          "pathParts": [
            "functions",
            "multi-agent-worker",
            "host.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-local-settings",
          "category": "functions",
          "pathParts": [
            "functions",
            "multi-agent-worker",
            "local.settings.example.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-requirements",
          "category": "functions",
          "pathParts": [
            "functions",
            "multi-agent-worker",
            "requirements.txt"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-app",
          "category": "functions",
          "pathParts": [
            "functions",
            "multi-agent-worker",
            "function_app.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-test",
          "category": "functions-test",
          "pathParts": [
            "functions",
            "multi-agent-worker",
            "tests",
            "test_function_app.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-funcignore",
          "category": "functions",
          "pathParts": [
            "functions",
            "multi-agent-worker",
            ".funcignore"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-gitignore",
          "category": "functions",
          "pathParts": [
            "functions",
            "multi-agent-worker",
            ".gitignore"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "multi-agent"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "pattern-worker",
          "category": "pattern",
          "pathParts": [
            "backend",
            "workers",
            "workflow_worker.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ]
          }
        },
        {
          "logicalName": "function-worker-readme",
          "category": "functions",
          "pathParts": [
            "functions",
            "workflow-worker",
            "README.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-host",
          "category": "functions",
          "pathParts": [
            "functions",
            "workflow-worker",
            "host.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-local-settings",
          "category": "functions",
          "pathParts": [
            "functions",
            "workflow-worker",
            "local.settings.example.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-requirements",
          "category": "functions",
          "pathParts": [
            "functions",
            "workflow-worker",
            "requirements.txt"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-app",
          "category": "functions",
          "pathParts": [
            "functions",
            "workflow-worker",
            "function_app.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-test",
          "category": "functions-test",
          "pathParts": [
            "functions",
            "workflow-worker",
            "tests",
            "test_function_app.py"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-funcignore",
          "category": "functions",
          "pathParts": [
            "functions",
            "workflow-worker",
            ".funcignore"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        },
        {
          "logicalName": "function-worker-gitignore",
          "category": "functions",
          "pathParts": [
            "functions",
            "workflow-worker",
            ".gitignore"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base",
          "when": {
            "variant": [
              "workflow"
            ],
            "cloud": [
              "azure"
            ]
          }
        }
      ],
      "assets": [
        {
          "id": "python-standard-project",
          "pathParts": [
            "assets",
            "plugins",
            "python-fastapi",
            "python-standard",
            "pyproject.toml"
          ]
        },
        {
          "id": "python-standard-lock",
          "pathParts": [
            "assets",
            "plugins",
            "python-fastapi",
            "python-standard",
            "uv.lock"
          ]
        },
        {
          "id": "python-genai-project",
          "pathParts": [
            "assets",
            "plugins",
            "python-fastapi",
            "python-genai",
            "pyproject.toml"
          ]
        },
        {
          "id": "python-genai-lock",
          "pathParts": [
            "assets",
            "plugins",
            "python-fastapi",
            "python-genai",
            "uv.lock"
          ]
        },
        {
          "id": "python-genai-function-requirements",
          "pathParts": [
            "assets",
            "plugins",
            "python-fastapi",
            "python-genai",
            "function-requirements.txt"
          ]
        }
      ],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 2
    },
    {
      "category": "stack",
      "id": "node-fastify",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {
          "workload": [
            "standard"
          ]
        }
      ],
      "artifacts": [
        {
          "logicalName": "node-backend-package",
          "category": "backend",
          "pathParts": [
            "backend",
            "package.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-lock",
          "category": "backend",
          "pathParts": [
            "backend",
            "package-lock.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-tsconfig",
          "category": "backend",
          "pathParts": [
            "backend",
            "tsconfig.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-drizzle-config",
          "category": "backend",
          "pathParts": [
            "backend",
            "drizzle.config.ts"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-config",
          "category": "backend",
          "pathParts": [
            "backend",
            "src",
            "config.ts"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-app",
          "category": "backend",
          "pathParts": [
            "backend",
            "src",
            "app.ts"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-server",
          "category": "backend",
          "pathParts": [
            "backend",
            "src",
            "server.ts"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-database",
          "category": "backend",
          "pathParts": [
            "backend",
            "src",
            "database.ts"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-schema",
          "category": "backend",
          "pathParts": [
            "backend",
            "src",
            "db",
            "schema.ts"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-test-health",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "test",
            "health.test.ts"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "node-backend-vitest-config",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "vitest.config.ts"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-node-migration",
          "category": "database",
          "pathParts": [
            "database",
            "migrations",
            "0000_initial.sql"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-node-migration-journal",
          "category": "database",
          "pathParts": [
            "database",
            "migrations",
            "meta",
            "_journal.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-node-migration-snapshot",
          "category": "database",
          "pathParts": [
            "database",
            "migrations",
            "meta",
            "0000_snapshot.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-schema",
          "category": "database",
          "pathParts": [
            "database",
            "models",
            "schema.sql"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        }
      ],
      "assets": [
        {
          "id": "node-backend-package-manifest",
          "pathParts": [
            "assets",
            "plugins",
            "node-fastify",
            "node-backend",
            "package.json"
          ]
        },
        {
          "id": "node-backend-package-lock",
          "pathParts": [
            "assets",
            "plugins",
            "node-fastify",
            "node-backend",
            "package-lock.json"
          ]
        }
      ],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 3
    },
    {
      "category": "stack",
      "id": "go-huma",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {
          "workload": [
            "standard"
          ]
        }
      ],
      "artifacts": [
        {
          "logicalName": "go-backend-module",
          "category": "backend",
          "pathParts": [
            "backend",
            "go.mod"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-backend-checksums",
          "category": "backend",
          "pathParts": [
            "backend",
            "go.sum"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-backend-makefile",
          "category": "backend",
          "pathParts": [
            "backend",
            "Makefile"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-backend-main",
          "category": "backend",
          "pathParts": [
            "backend",
            "cmd",
            "api",
            "main.go"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-backend-migration-command",
          "category": "backend",
          "pathParts": [
            "backend",
            "cmd",
            "migrate",
            "main.go"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-backend-api",
          "category": "backend",
          "pathParts": [
            "backend",
            "internal",
            "api",
            "api.go"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-backend-config",
          "category": "backend",
          "pathParts": [
            "backend",
            "internal",
            "config",
            "config.go"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-runtime-config-example",
          "category": "configuration",
          "pathParts": [
            "runtime.config.example.json"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-backend-database",
          "category": "backend",
          "pathParts": [
            "backend",
            "internal",
            "database",
            "database.go"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "go-backend-test-health",
          "category": "backend-test",
          "pathParts": [
            "backend",
            "internal",
            "api",
            "api_test.go"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-go-migration",
          "category": "database",
          "pathParts": [
            "database",
            "migrations",
            "0001_initial.sql"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "database-schema",
          "category": "database",
          "pathParts": [
            "database",
            "models",
            "schema.sql"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        }
      ],
      "assets": [
        {
          "id": "go-backend-module",
          "pathParts": [
            "assets",
            "plugins",
            "go-huma",
            "go-backend",
            "go.mod"
          ]
        },
        {
          "id": "go-backend-checksums",
          "pathParts": [
            "assets",
            "plugins",
            "go-huma",
            "go-backend",
            "go.sum"
          ]
        }
      ],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 1
    },
    {
      "category": "cloud",
      "id": "azure",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {}
      ],
      "artifacts": [
        {
          "logicalName": "opentofu-application-versions",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "modules",
            "application",
            "versions.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "opentofu-application-variables",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "modules",
            "application",
            "variables.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "opentofu-application-main",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "modules",
            "application",
            "main.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "opentofu-application-outputs",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "modules",
            "application",
            "outputs.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "opentofu-readme",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "README.md"
          ],
          "lifecycle": "project",
          "provisioningGroup": "base"
        },
        {
          "logicalName": "opentofu-dev-versions",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            "versions.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-dev-provider-lock",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            ".terraform.lock.hcl"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-dev-providers",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            "providers.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-dev-variables",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            "variables.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-dev-main",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            "main.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-dev-outputs",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            "outputs.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-dev-local-state",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            "backend.local.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-dev-remote-state-example",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            "backend.remote.example.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-dev-tfvars",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "dev",
            "dev.tfvars"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:dev",
          "when": {
            "environment": [
              "dev"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-versions",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            "versions.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-provider-lock",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            ".terraform.lock.hcl"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-providers",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            "providers.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-variables",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            "variables.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-main",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            "main.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-outputs",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            "outputs.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-local-state",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            "backend.local.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-remote-state-example",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            "backend.remote.example.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-staging-tfvars",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "staging",
            "staging.tfvars"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:staging",
          "when": {
            "environment": [
              "staging"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-versions",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            "versions.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-provider-lock",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            ".terraform.lock.hcl"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-providers",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            "providers.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-variables",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            "variables.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-main",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            "main.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-outputs",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            "outputs.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-local-state",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            "backend.local.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-remote-state-example",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            "backend.remote.example.tf"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        },
        {
          "logicalName": "opentofu-prod-tfvars",
          "category": "infrastructure",
          "pathParts": [
            "infrastructure",
            "opentofu",
            "azure",
            "environments",
            "prod",
            "prod.tfvars"
          ],
          "lifecycle": "project",
          "provisioningGroup": "environment:prod",
          "when": {
            "environment": [
              "prod"
            ]
          }
        }
      ],
      "assets": [
        {
          "id": "opentofu-azure-versions",
          "pathParts": [
            "assets",
            "plugins",
            "azure",
            "opentofu-azure",
            "versions.tf"
          ]
        },
        {
          "id": "opentofu-azure-provider-lock",
          "pathParts": [
            "assets",
            "plugins",
            "azure",
            "opentofu-azure",
            ".terraform.lock.hcl"
          ]
        }
      ],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 1
    },
    {
      "category": "workflow",
      "id": "openspec",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {}
      ],
      "artifacts": [
        {
          "logicalName": "openspec-config",
          "category": "seed",
          "pathParts": [
            "openspec",
            "config.yaml"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "openspec-seed-change-metadata",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            ".openspec.yaml"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "openspec-seed-proposal",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "proposal.md"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "openspec-seed-design",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "design.md"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "openspec-seed-tasks",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "tasks.md"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "python-fastapi-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "workload": [
              "standard"
            ],
            "stack": [
              "python-fastapi"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "node-fastify-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "workload": [
              "standard"
            ],
            "stack": [
              "node-fastify"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "go-huma-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "workload": [
              "standard"
            ],
            "stack": [
              "go-huma"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "generic-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "generic"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "rag-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "rag"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "chatbot-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "chatbot"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "agent-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "agent"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "prompt-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "prompt"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "multi-agent-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "multi-agent"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "fine-tuned-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "fine-tuned"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "streaming-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "streaming"
            ]
          }
        },
        {
          "logicalName": "openspec-seed-spec",
          "category": "seed",
          "pathParts": [
            "openspec",
            "changes",
            "_bootstrap-change_",
            "specs",
            "workflow-application-baseline",
            "spec.md"
          ],
          "lifecycle": "seed",
          "when": {
            "variant": [
              "workflow"
            ]
          }
        },
        {
          "logicalName": "openspec-spec-placeholder",
          "category": "seed",
          "pathParts": [
            "openspec",
            "specs",
            ".gitkeep"
          ],
          "lifecycle": "seed"
        }
      ],
      "assets": [],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 1
    },
    {
      "category": "workflow",
      "id": "spec-kit",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {}
      ],
      "artifacts": [
        {
          "logicalName": "spec-kit-constitution",
          "category": "seed",
          "pathParts": [
            ".specify",
            "memory",
            "constitution.md"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "spec-kit-spec-template",
          "category": "framework",
          "pathParts": [
            ".specify",
            "templates",
            "spec-template.md"
          ],
          "lifecycle": "framework"
        },
        {
          "logicalName": "spec-kit-plan-template",
          "category": "framework",
          "pathParts": [
            ".specify",
            "templates",
            "plan-template.md"
          ],
          "lifecycle": "framework"
        },
        {
          "logicalName": "specs-placeholder",
          "category": "seed",
          "pathParts": [
            "specs",
            ".gitkeep"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "spec-kit-bootstrap-spec",
          "category": "seed",
          "pathParts": [
            "specs",
            "000-liftoff-bootstrap",
            "spec.md"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "spec-kit-bootstrap-plan",
          "category": "seed",
          "pathParts": [
            "specs",
            "000-liftoff-bootstrap",
            "plan.md"
          ],
          "lifecycle": "seed"
        },
        {
          "logicalName": "spec-kit-bootstrap-tasks",
          "category": "seed",
          "pathParts": [
            "specs",
            "000-liftoff-bootstrap",
            "tasks.md"
          ],
          "lifecycle": "seed"
        }
      ],
      "assets": [],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 1
    },
    {
      "category": "agent",
      "id": "github-copilot",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {}
      ],
      "artifacts": [
        {
          "logicalName": "liftoff-setup-copilot",
          "category": "governance",
          "pathParts": [
            ".github",
            "prompts",
            "liftoff-setup.prompt.md"
          ],
          "lifecycle": "managed-core",
          "when": {
            "governanceProfile": [
              "single-maintainer-gitflow",
              "team-gitflow"
            ]
          }
        },
        {
          "logicalName": "liftoff-governance-assess-copilot",
          "category": "governance",
          "pathParts": [
            ".github",
            "prompts",
            "liftoff-governance-assess.prompt.md"
          ],
          "lifecycle": "managed-core",
          "when": {
            "governanceProfile": [
              "single-maintainer-gitflow",
              "team-gitflow"
            ]
          }
        },
        {
          "logicalName": "liftoff-repair-copilot",
          "category": "governance",
          "pathParts": [
            ".github",
            "prompts",
            "liftoff-repair.prompt.md"
          ],
          "lifecycle": "managed-core"
        }
      ],
      "assets": [],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 2
    },
    {
      "category": "agent",
      "id": "claude",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {}
      ],
      "artifacts": [
        {
          "logicalName": "liftoff-setup-claude",
          "category": "governance",
          "pathParts": [
            ".claude",
            "commands",
            "liftoff-setup.md"
          ],
          "lifecycle": "managed-core",
          "when": {
            "governanceProfile": [
              "single-maintainer-gitflow",
              "team-gitflow"
            ]
          }
        },
        {
          "logicalName": "liftoff-governance-assess-claude",
          "category": "governance",
          "pathParts": [
            ".claude",
            "commands",
            "liftoff-governance-assess.md"
          ],
          "lifecycle": "managed-core",
          "when": {
            "governanceProfile": [
              "single-maintainer-gitflow",
              "team-gitflow"
            ]
          }
        },
        {
          "logicalName": "liftoff-repair-claude",
          "category": "governance",
          "pathParts": [
            ".claude",
            "commands",
            "liftoff-repair.md"
          ],
          "lifecycle": "managed-core"
        }
      ],
      "assets": [],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 2
    },
    {
      "category": "agent",
      "id": "codex",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {}
      ],
      "artifacts": [
        {
          "logicalName": "liftoff-setup-codex",
          "category": "governance",
          "pathParts": [
            ".agents",
            "skills",
            "liftoff-setup",
            "SKILL.md"
          ],
          "lifecycle": "managed-core",
          "when": {
            "governanceProfile": [
              "single-maintainer-gitflow",
              "team-gitflow"
            ]
          }
        },
        {
          "logicalName": "liftoff-governance-assess-codex",
          "category": "governance",
          "pathParts": [
            ".agents",
            "skills",
            "liftoff-governance-assess",
            "SKILL.md"
          ],
          "lifecycle": "managed-core",
          "when": {
            "governanceProfile": [
              "single-maintainer-gitflow",
              "team-gitflow"
            ]
          }
        },
        {
          "logicalName": "liftoff-repair-codex",
          "category": "governance",
          "pathParts": [
            ".agents",
            "skills",
            "liftoff-repair",
            "SKILL.md"
          ],
          "lifecycle": "managed-core"
        }
      ],
      "assets": [],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 2
    },
    {
      "category": "workflow",
      "id": "manual",
      "apiVersion": 1,
      "hostPlatforms": [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/x64"
      ],
      "supports": [
        {}
      ],
      "artifacts": [],
      "assets": [],
      "sharedAssets": [],
      "checks": [],
      "recipes": [],
      "contentVersion": 1
    }
  ],
  "core": {
    "artifacts": [
      {
        "logicalName": "root-readme",
        "category": "documentation",
        "pathParts": [
          "README.md"
        ],
        "lifecycle": "project",
        "provisioningGroup": "base"
      },
      {
        "logicalName": "root-gitignore",
        "category": "project",
        "pathParts": [
          ".gitignore"
        ],
        "lifecycle": "project",
        "provisioningGroup": "base"
      },
      {
        "logicalName": "root-dockerignore",
        "category": "runtime",
        "pathParts": [
          ".dockerignore"
        ],
        "lifecycle": "project",
        "provisioningGroup": "base"
      },
      {
        "logicalName": "env-example",
        "category": "configuration",
        "pathParts": [
          ".env.example"
        ],
        "lifecycle": "project",
        "provisioningGroup": "base"
      },
      {
        "logicalName": "backend-dockerfile",
        "category": "runtime",
        "pathParts": [
          "Dockerfile"
        ],
        "lifecycle": "project",
        "provisioningGroup": "base"
      },
      {
        "logicalName": "docker-compose",
        "category": "local-development",
        "pathParts": [
          "docker-compose.yml"
        ],
        "lifecycle": "project",
        "provisioningGroup": "base"
      },
      {
        "logicalName": "liftoff-config",
        "category": "project",
        "pathParts": [
          "liftoff.config.json"
        ],
        "lifecycle": "desired-state"
      },
      {
        "logicalName": "manifest",
        "category": "manifest",
        "pathParts": [
          "liftoff.manifest.json"
        ],
        "lifecycle": "manifest"
      },
      {
        "logicalName": "environment-dev-backend",
        "category": "environment",
        "pathParts": [
          "environments",
          "dev",
          "backend.env"
        ],
        "lifecycle": "project",
        "provisioningGroup": "environment:dev",
        "when": {
          "environment": [
            "dev"
          ]
        }
      },
      {
        "logicalName": "environment-dev-functions",
        "category": "environment",
        "pathParts": [
          "environments",
          "dev",
          "functions.env"
        ],
        "lifecycle": "project",
        "provisioningGroup": "environment:dev",
        "when": {
          "workload": [
            "genai"
          ],
          "variant": [
            "rag",
            "agent",
            "multi-agent",
            "workflow"
          ],
          "cloud": [
            "azure"
          ],
          "environment": [
            "dev"
          ]
        }
      },
      {
        "logicalName": "environment-staging-backend",
        "category": "environment",
        "pathParts": [
          "environments",
          "staging",
          "backend.env"
        ],
        "lifecycle": "project",
        "provisioningGroup": "environment:staging",
        "when": {
          "environment": [
            "staging"
          ]
        }
      },
      {
        "logicalName": "environment-staging-functions",
        "category": "environment",
        "pathParts": [
          "environments",
          "staging",
          "functions.env"
        ],
        "lifecycle": "project",
        "provisioningGroup": "environment:staging",
        "when": {
          "workload": [
            "genai"
          ],
          "variant": [
            "rag",
            "agent",
            "multi-agent",
            "workflow"
          ],
          "cloud": [
            "azure"
          ],
          "environment": [
            "staging"
          ]
        }
      },
      {
        "logicalName": "environment-prod-backend",
        "category": "environment",
        "pathParts": [
          "environments",
          "prod",
          "backend.env"
        ],
        "lifecycle": "project",
        "provisioningGroup": "environment:prod",
        "when": {
          "environment": [
            "prod"
          ]
        }
      },
      {
        "logicalName": "environment-prod-functions",
        "category": "environment",
        "pathParts": [
          "environments",
          "prod",
          "functions.env"
        ],
        "lifecycle": "project",
        "provisioningGroup": "environment:prod",
        "when": {
          "workload": [
            "genai"
          ],
          "variant": [
            "rag",
            "agent",
            "multi-agent",
            "workflow"
          ],
          "cloud": [
            "azure"
          ],
          "environment": [
            "prod"
          ]
        }
      },
      {
        "logicalName": "frontend-package",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "package.json"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-lock",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "package-lock.json"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-index",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "index.html"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-main",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "src",
          "main.ts"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-app",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "src",
          "App.vue"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-env-example",
        "category": "frontend",
        "pathParts": [
          "frontend",
          ".env.example"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-styles",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "src",
          "styles.css"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-vite-config",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "vite.config.ts"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-tailwind-config",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "tailwind.config.ts"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-dockerfile",
        "category": "frontend",
        "pathParts": [
          "frontend",
          "Dockerfile"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "frontend-dockerignore",
        "category": "frontend",
        "pathParts": [
          "frontend",
          ".dockerignore"
        ],
        "lifecycle": "project",
        "provisioningGroup": "frontend",
        "when": {
          "frontend": [
            "included"
          ]
        }
      },
      {
        "logicalName": "repository-governance-policy",
        "category": "governance",
        "pathParts": [
          ".liftoff",
          "governance",
          "policy.md"
        ],
        "lifecycle": "managed-core",
        "when": {
          "governanceProfile": [
            "single-maintainer-gitflow",
            "team-gitflow"
          ]
        }
      },
      {
        "logicalName": "repository-governance-context",
        "category": "governance",
        "pathParts": [
          ".liftoff",
          "governance",
          "context.json"
        ],
        "lifecycle": "managed-core",
        "when": {
          "governanceProfile": [
            "single-maintainer-gitflow",
            "team-gitflow"
          ]
        }
      },
      {
        "logicalName": "repository-governance-guide",
        "category": "governance",
        "pathParts": [
          ".liftoff",
          "governance",
          "README.md"
        ],
        "lifecycle": "managed-core",
        "when": {
          "governanceProfile": [
            "single-maintainer-gitflow",
            "team-gitflow"
          ]
        }
      },
      {
        "logicalName": "repository-governance-phase-graph",
        "category": "governance",
        "pathParts": [
          ".liftoff",
          "governance",
          "phase-graph.json"
        ],
        "lifecycle": "managed-core",
        "when": {
          "governanceProfile": [
            "single-maintainer-gitflow",
            "team-gitflow"
          ]
        }
      },
      {
        "logicalName": "repository-governance-compatibility",
        "category": "governance",
        "pathParts": [
          ".liftoff",
          "governance",
          "compatibility.json"
        ],
        "lifecycle": "managed-core",
        "when": {
          "governanceProfile": [
            "single-maintainer-gitflow",
            "team-gitflow"
          ]
        }
      },
      {
        "logicalName": "repository-governance-credential-policy-schema",
        "category": "governance",
        "pathParts": [
          ".liftoff",
          "governance",
          "credential-policy.schema.json"
        ],
        "lifecycle": "managed-core",
        "when": {
          "governanceProfile": [
            "single-maintainer-gitflow",
            "team-gitflow"
          ]
        }
      }
    ],
    "sharedAssets": [
      {
        "id": "frontend-package-manifest",
        "pathParts": [
          "assets",
          "templates",
          "common",
          "frontend",
          "package.json"
        ]
      },
      {
        "id": "frontend-package-lock",
        "pathParts": [
          "assets",
          "templates",
          "common",
          "frontend",
          "package-lock.json"
        ]
      },
      {
        "id": "modern-single-maintainer-policy",
        "pathParts": [
          "assets",
          "governance",
          "single-maintainer-gitflow",
          "policy-v7.md"
        ]
      },
      {
        "id": "modern-team-policy",
        "pathParts": [
          "assets",
          "governance",
          "team-gitflow",
          "policy-v1.md"
        ]
      },
      {
        "id": "modern-governance-source-contracts",
        "pathParts": [
          "assets",
          "governance",
          "modern",
          "source-contracts.json"
        ]
      }
    ],
    "managedCore": [
      {
        "logicalName": "repository-governance-policy",
        "pathParts": [
          ".liftoff",
          "governance",
          "policy.md"
        ]
      },
      {
        "logicalName": "repository-governance-context",
        "pathParts": [
          ".liftoff",
          "governance",
          "context.json"
        ]
      },
      {
        "logicalName": "repository-governance-guide",
        "pathParts": [
          ".liftoff",
          "governance",
          "README.md"
        ]
      },
      {
        "logicalName": "repository-governance-phase-graph",
        "pathParts": [
          ".liftoff",
          "governance",
          "phase-graph.json"
        ]
      },
      {
        "logicalName": "repository-governance-compatibility",
        "pathParts": [
          ".liftoff",
          "governance",
          "compatibility.json"
        ]
      },
      {
        "logicalName": "repository-governance-credential-policy-schema",
        "pathParts": [
          ".liftoff",
          "governance",
          "credential-policy.schema.json"
        ]
      },
      {
        "logicalName": "liftoff-setup-copilot",
        "pathParts": [
          ".github",
          "prompts",
          "liftoff-setup.prompt.md"
        ]
      },
      {
        "logicalName": "liftoff-governance-assess-copilot",
        "pathParts": [
          ".github",
          "prompts",
          "liftoff-governance-assess.prompt.md"
        ]
      },
      {
        "logicalName": "liftoff-repair-copilot",
        "pathParts": [
          ".github",
          "prompts",
          "liftoff-repair.prompt.md"
        ]
      },
      {
        "logicalName": "liftoff-setup-claude",
        "pathParts": [
          ".claude",
          "commands",
          "liftoff-setup.md"
        ]
      },
      {
        "logicalName": "liftoff-governance-assess-claude",
        "pathParts": [
          ".claude",
          "commands",
          "liftoff-governance-assess.md"
        ]
      },
      {
        "logicalName": "liftoff-repair-claude",
        "pathParts": [
          ".claude",
          "commands",
          "liftoff-repair.md"
        ]
      },
      {
        "logicalName": "liftoff-setup-codex",
        "pathParts": [
          ".agents",
          "skills",
          "liftoff-setup",
          "SKILL.md"
        ]
      },
      {
        "logicalName": "liftoff-governance-assess-codex",
        "pathParts": [
          ".agents",
          "skills",
          "liftoff-governance-assess",
          "SKILL.md"
        ]
      },
      {
        "logicalName": "liftoff-repair-codex",
        "pathParts": [
          ".agents",
          "skills",
          "liftoff-repair",
          "SKILL.md"
        ]
      }
    ],
    "retiredLogicalNames": [
      "repository-governance-copilot-launcher",
      "repository-governance-claude-launcher",
      "opentofu-versions",
      "opentofu-provider-lock",
      "opentofu-providers",
      "opentofu-variables",
      "opentofu-main",
      "opentofu-outputs",
      "opentofu-local-state",
      "opentofu-remote-state-example"
    ]
  },
  "selectionSpace": {
    "workloads": [
      {
        "id": "genai",
        "variants": [
          "generic",
          "rag",
          "chatbot",
          "agent",
          "prompt",
          "multi-agent",
          "fine-tuned",
          "streaming",
          "workflow"
        ]
      },
      {
        "id": "standard",
        "variants": []
      }
    ],
    "environments": [
      "dev",
      "staging",
      "prod"
    ],
    "governanceProfiles": [
      "none",
      "single-maintainer-gitflow",
      "team-gitflow"
    ]
  },
  "operations": [],
  "release": {
    "schemaVersion": 1,
    "sharedAssets": [
      {
        "id": "frontend-package-manifest",
        "pathParts": [
          "assets",
          "templates",
          "common",
          "frontend",
          "package.json"
        ],
        "sha256": "sha256:8217179388207e3d8e8599544e7741b29beb6dded81f01bcf5d4356785a68561"
      },
      {
        "id": "frontend-package-lock",
        "pathParts": [
          "assets",
          "templates",
          "common",
          "frontend",
          "package-lock.json"
        ],
        "sha256": "sha256:7e454f0ab739038e99569d174045673776b4565786b1f81764b4c3ee785638b5"
      },
      {
        "id": "modern-single-maintainer-policy",
        "pathParts": [
          "assets",
          "governance",
          "single-maintainer-gitflow",
          "policy-v7.md"
        ],
        "sha256": "sha256:d39036cf736fa95480b3289c63a34cac9ecee7f4cd4cdd1d779f94aed98b4706"
      },
      {
        "id": "modern-team-policy",
        "pathParts": [
          "assets",
          "governance",
          "team-gitflow",
          "policy-v1.md"
        ],
        "sha256": "sha256:707bd85e1fee60ccf023eebcb4f33a0458a0014ee0f92fe9e398d2e7fe4b7646"
      },
      {
        "id": "modern-governance-source-contracts",
        "pathParts": [
          "assets",
          "governance",
          "modern",
          "source-contracts.json"
        ],
        "sha256": "sha256:b336953323f1099a429e35cb22a39c9dda48e884bc5e610bfa44424db914bcf6"
      }
    ],
    "plugins": [
      {
        "category": "stack",
        "id": "python-fastapi",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:44f91983bc9b69360cb6c0f35c61b8e0132bd4bfd1f7c93c1bf696d525bed7ea",
        "assets": [
          {
            "id": "python-standard-project",
            "pathParts": [
              "assets",
              "plugins",
              "python-fastapi",
              "python-standard",
              "pyproject.toml"
            ],
            "sha256": "sha256:dc551853962b84bec527bb3463801b74ab9681b41d362653892243836a6e6935"
          },
          {
            "id": "python-standard-lock",
            "pathParts": [
              "assets",
              "plugins",
              "python-fastapi",
              "python-standard",
              "uv.lock"
            ],
            "sha256": "sha256:4bc135105548ce5d16d64fe034be6993cf722f75f51ac4d728a56c35c80d0dc2"
          },
          {
            "id": "python-genai-project",
            "pathParts": [
              "assets",
              "plugins",
              "python-fastapi",
              "python-genai",
              "pyproject.toml"
            ],
            "sha256": "sha256:94cbed85dbaf807866b4908703106d19e01eee9a30b7ccf186b88f68d8154745"
          },
          {
            "id": "python-genai-lock",
            "pathParts": [
              "assets",
              "plugins",
              "python-fastapi",
              "python-genai",
              "uv.lock"
            ],
            "sha256": "sha256:2d6c651f9237d092ef56461b3f492aa19b1a825f08f14608b3cc2d020d89e16d"
          },
          {
            "id": "python-genai-function-requirements",
            "pathParts": [
              "assets",
              "plugins",
              "python-fastapi",
              "python-genai",
              "function-requirements.txt"
            ],
            "sha256": "sha256:6297c0dbb51146fa6188b380e026d6a31f61d1cec9c5586aa495ff1dca26ef46"
          }
        ]
      },
      {
        "category": "stack",
        "id": "node-fastify",
        "apiVersion": 1,
        "contentVersion": 3,
        "contentDigest": "sha256:2140749905f08e15db0e18c0b0b97ffd72a9f7fb30ae5469c7678822e1dcee7c",
        "assets": [
          {
            "id": "node-backend-package-manifest",
            "pathParts": [
              "assets",
              "plugins",
              "node-fastify",
              "node-backend",
              "package.json"
            ],
            "sha256": "sha256:ce24c806c0ebc3f54b79647422b44afafb4cbe9ec4b2b062e934aa8fc78c4481"
          },
          {
            "id": "node-backend-package-lock",
            "pathParts": [
              "assets",
              "plugins",
              "node-fastify",
              "node-backend",
              "package-lock.json"
            ],
            "sha256": "sha256:bbb0ca538b14a79382236cee07cf4200b83129d59176b58cf1f9df88e4c4393d"
          }
        ]
      },
      {
        "category": "stack",
        "id": "go-huma",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:89f2689d613fcd5708bf9a94b5138cc0d39fb3c0c18374c75a190e7ee8ba1432",
        "assets": [
          {
            "id": "go-backend-module",
            "pathParts": [
              "assets",
              "plugins",
              "go-huma",
              "go-backend",
              "go.mod"
            ],
            "sha256": "sha256:b4a00ccd7a9881c7e518dcbba83bd8ead0a852b29cb2509402f3c8c9af5bafac"
          },
          {
            "id": "go-backend-checksums",
            "pathParts": [
              "assets",
              "plugins",
              "go-huma",
              "go-backend",
              "go.sum"
            ],
            "sha256": "sha256:c4c5f94664176df8c09e6fbf02a48391e606d135caec6b75932271333bbb4fb5"
          }
        ]
      },
      {
        "category": "cloud",
        "id": "azure",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:f7b67895895c43bff579a5108d0dffd5171dbd6cbdf56fd99e725e41a672f6d7",
        "assets": [
          {
            "id": "opentofu-azure-versions",
            "pathParts": [
              "assets",
              "plugins",
              "azure",
              "opentofu-azure",
              "versions.tf"
            ],
            "sha256": "sha256:7f1b60e1d88e6e8f0bc3981fafbb33b9d1471b3fe028b2eaa757d01d7f7001af"
          },
          {
            "id": "opentofu-azure-provider-lock",
            "pathParts": [
              "assets",
              "plugins",
              "azure",
              "opentofu-azure",
              ".terraform.lock.hcl"
            ],
            "sha256": "sha256:e4a061da79009c7e1c2f9cb356b3a4df0bb05802f9b98f30de79c351c280ef61"
          }
        ]
      },
      {
        "category": "workflow",
        "id": "openspec",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:8675a3187f44932c7bee9f9a8e5d3f307bcb36d66ced0f20593663221c509d5e",
        "assets": []
      },
      {
        "category": "workflow",
        "id": "spec-kit",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:420fd4584bf02e8efc65bf9893848a4748ce676c030095de9ef1fba20ca7a137",
        "assets": []
      },
      {
        "category": "agent",
        "id": "github-copilot",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:e27664b5c85487cdf40fbf7da40691b3fb26d71d0026686152842d167bc46ce8",
        "assets": []
      },
      {
        "category": "agent",
        "id": "claude",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:001e1e7b1ee4e8b9f2f4ed250ed9d1eada084ef33992682165821277379cbfb1",
        "assets": []
      },
      {
        "category": "agent",
        "id": "codex",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:4ad1642e726ac08037442f67a63b714bc544821a185281defdc6c682227e3b39",
        "assets": []
      },
      {
        "category": "workflow",
        "id": "manual",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:0a97939a6f22ff7a388d41136fc513ddd1f043e2ef2f9a3f3694a3557ca0b3e9",
        "assets": []
      }
    ]
  }
} satisfies Omit<PluginRegistryInput, 'assets'>);
