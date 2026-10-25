import type { PatternMaturity, PatternPlugin } from "../contracts/project-plugin.ts";
import { filesFrom } from "./files.ts";

/** The pattern's maturity as README Markdown, from the same metadata as the docs. */
export function maturityMarkdown(maturity: PatternMaturity): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
  return [
    `**Maturity: ${maturity.level}.** What it does:`,
    "",
    list(maturity.implemented),
    "",
    "What it does not do yet:",
    "",
    list(maturity.notImplemented),
  ].join("\n");
}

function pattern(
  name: string,
  summary: string,
  maturity: PatternMaturity,
  layout: PatternPlugin["layout"] = [],
): PatternPlugin {
  const root = `plugins/pattern-${name}`;
  return {
    id: `pattern/${name}`,
    kind: "pattern",
    name,
    version: "1",
    summary,
    templateRoots: [`${root}/files`, `${root}/parts`],
    parts: `${root}/parts`,
    checks: [],
    tools: [],
    reviewRules: [],
    layout: [
      { path: "backend/app/pattern.py", purpose: `the ${name} pattern's endpoints` },
      ...layout,
    ],
    maturity,
    readmeValues: () => ({ maturity: maturityMarkdown(maturity) }),
    artifacts: ({ templates, config }) =>
      filesFrom(templates, `${root}/files`, { name: config.name }, "seeded"),
  };
}

/**
 * The nine GenAI patterns. `generic` is the neutral default. Each says plainly
 * what it implements and what a production use would still need: extension
 * points and in-memory stand-ins are never presented as finished features.
 */
export const PATTERN_LIST: readonly PatternPlugin[] = [
  pattern("generic", "One instruction-following agent behind one endpoint", {
    level: "complete",
    implemented: [
      "A single model call per request, following configurable instructions",
      "Timeouts and provider failures answered as 504 and 502",
    ],
    notImplemented: ["Tools, structured output, memory or retrieval: add them as needed"],
  }),
  pattern(
    "prompt",
    "Named prompt templates, versioned with the code",
    {
      level: "complete",
      implemented: [
        "Prompt templates as files in backend/app/prompts, listed with their variables",
        "Requests fill a template; missing or unknown variables are refused",
      ],
      notImplemented: [
        "A prompt registry, prompt versions served side by side, or A/B testing",
        "Evaluation of prompt changes",
      ],
    },
    [{ path: "backend/app/prompts/", purpose: "the prompt templates" }],
  ),
  pattern("chatbot", "Conversations that keep their message history", {
    level: "foundation",
    implemented: [
      "Conversations with an id, each keeping its message history for the model",
      "A bounded number of conversations and messages",
    ],
    notImplemented: [
      "Persistent history: it lives in one process and is lost on restart",
      "Sharing conversations between replicas, users or authentication",
      "Ordering two messages sent to one conversation at the same time",
    ],
  }),
  pattern(
    "rag",
    "Answers grounded in the project's documents, with their sources",
    {
      level: "foundation",
      implemented: [
        "Documents in backend/app/documents, split into passages at startup",
        "Keyword retrieval of the best passages, which the answer must rely on",
        "The sources of every answer, and no model call when nothing matches",
      ],
      notImplemented: [
        "Embeddings or a vector store such as pgvector: retrieval is lexical",
        "Ingestion of new documents while running, or document permissions",
        "Evaluation of answer quality",
      ],
    },
    [{ path: "backend/app/documents/", purpose: "the documents answers are grounded in" }],
  ),
  pattern("agent", "An agent that calls tools to complete a task", {
    level: "foundation",
    implemented: [
      "Tool calling, with two safe example tools: the time and arithmetic",
      "The tools each task used, returned with the answer",
    ],
    notImplemented: [
      "Sandboxing: tools run in the API's process",
      "Approval before tools with side effects, or limits per user",
    ],
  }),
  pattern("multi-agent", "A coordinator that delegates to specialist agents", {
    level: "foundation",
    implemented: [
      "A coordinator agent that delegates to a researcher and a writer",
      "The delegations each task made, returned with the answer",
    ],
    notImplemented: [
      "Dynamic planning or specialists chosen at run time",
      "Running specialists in parallel, or sharing memory between them",
    ],
  }),
  pattern(
    "fine-tuned",
    "Serving a fine-tuned model, with checks for its training data",
    {
      level: "foundation",
      implemented: [
        "Serving any fine-tuned model the provider hosts, named by APP_MODEL",
        "A checker for chat-format training data in JSON Lines",
      ],
      notImplemented: [
        "Training or uploading the model: that happens with the provider",
        "Comparing the fine-tuned model with its base model",
      ],
    },
    [
      {
        path: "backend/datasets/",
        purpose: "training data in chat format, checked by app.dataset",
      },
    ],
  ),
  pattern("streaming", "Answers streamed as they are written", {
    level: "complete",
    implemented: [
      "Server-sent events with each piece of text as the provider sends it",
      "A final event when the answer is complete, and an error event if it fails",
    ],
    notImplemented: ["Streaming structured output or tool calls", "Resuming a broken stream"],
  }),
  pattern(
    "workflow",
    "Multi-step work run in the background, through messaging and a worker",
    {
      level: "foundation",
      implemented: [
        "Workflows started with one request and run by a worker: a draft, then a review",
        "Messaging and worker boundaries with in-process adapters",
        "Each workflow's status and result",
      ],
      notImplemented: [
        "Durability: messages and workflows live in memory and are lost on restart",
        "Retries, scheduling, or a worker outside the API's process",
      ],
    },
    [
      {
        path: "backend/app/ports/",
        purpose: "also the messaging and worker boundaries the workflow runs on",
      },
    ],
  ),
];
