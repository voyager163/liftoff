import type { AddArtifact } from '../../template-types.js';
import { genAiPattern } from '../common/values.js';
import type { GenAiProjectPlan } from '../../domain/project/contracts.js';
import { pyModule } from '../common/values.js';

export function addPatternArtifacts(add: AddArtifact, plan: GenAiProjectPlan): void {
  const pattern = genAiPattern(plan);
  const routeModule = pyModule(pattern.id);
  add('pattern-agent', 'pattern', ['backend', 'orchestration', 'agents', `${routeModule}_agent.py`], renderPatternAgent(plan));
  add('pattern-agent-test', 'backend-test', ['backend', 'tests', `test_${routeModule}_orchestration.py`], renderPatternAgentTest(plan));
  add('pattern-prompt', 'pattern', ['backend', 'orchestration', 'prompts', `${pattern.id}.md`], renderPromptTemplate(plan));
  add('pattern-agent-package', 'pattern', ['backend', 'orchestration', 'agents', '__init__.py'], '');
  add('pattern-prompt-readme', 'pattern', ['backend', 'orchestration', 'prompts', 'README.md'], renderPromptReadme());

  if (pattern.id === 'rag') {
    add('rag-vector-store', 'pattern', ['backend', 'orchestration', 'retrieval', 'vector_store.py'], renderVectorStore());
    add('rag-retrieval-package', 'pattern', ['backend', 'orchestration', 'retrieval', '__init__.py'], '');
  }

  if (pattern.worker) {
    add('pattern-worker', 'pattern', ['backend', 'workers', `${routeModule}_worker.py`], renderPatternWorker(plan));
    add('backend-workers-package', 'pattern', ['backend', 'workers', '__init__.py'], '');
  }

  if (pattern.id === 'fine-tuned') {
    add('fine-tuned-eval-dataset', 'pattern', ['backend', 'evaluation', 'datasets', 'sample.jsonl'], '{"input":"Example request","expected":"Expected response placeholder"}');
  }
}

export function renderPatternAgent(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  if (pattern.id === 'rag') {
    return `from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner
from backend.orchestration.tools.messaging import MessagePublisher, build_message_publisher


async def _run_agent(
    operation: str,
    prompt: str,
    runner: AgentRunner | None,
    tracer: Tracer | None,
) -> str:
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    async with selected_tracer.trace(operation, {"prompt": prompt}) as trace:
        output = await selected_runner.run(prompt)
        trace.set_output({"text": output})
        return output


async def answer_question(
    question: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
) -> dict:
    answer = await _run_agent(
        "rag.query",
        f"Answer this question without claiming retrieval or citations.\\nQuestion: {question}",
        runner,
        tracer,
    )
    return {
        "answer": answer,
        "question": question,
        "citations": [],
    }


async def enqueue_ingestion(
    source_uri: str,
    *,
    publisher: MessagePublisher | None = None,
) -> dict:
    selected_publisher = publisher or build_message_publisher()
    await selected_publisher.publish("rag.ingest", {"source_uri": source_uri})
    return {"status": "queued", "source_uri": source_uri}
`;
  }
  if (pattern.id === 'streaming') {
    return `import json

from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner


async def stream_response(
    prompt: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
):
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    async with selected_tracer.trace("streaming.run", {"prompt": prompt}) as trace:
        output = await selected_runner.run(
            f"Respond concisely and safely to this request:\\n{prompt}"
        )
        trace.set_output({"text": output})
    yield f"data: {json.dumps({'text': output})}\\n\\n"
`;
  }
  const instruction = pattern.id === 'generic'
    ? 'Respond safely and usefully to this general-purpose AI request:'
    : `Respond to this ${pattern.id} starter input; no specialized orchestration is implemented:`;
  return `from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner


async def run_${moduleName}(
    input_text: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
) -> dict:
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    prompt = (
        "${instruction}\\n"
        f"{input_text}"
    )
    async with selected_tracer.trace("${pattern.id}.run", {"input": input_text}) as trace:
        output = await selected_runner.run(prompt)
        trace.set_output({"result": output})
    return {
        "result": output,
        "input": input_text,
    }
`;
}

export function renderPatternAgentTest(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  const agentModule = `backend.orchestration.agents.${moduleName}_agent`;
  if (pattern.id === 'rag') {
    return `import asyncio

import pytest

from ${agentModule} import answer_question, enqueue_ingestion
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "Question: What is Liftoff?" in prompt
        return "Liftoff is the generated orchestration starter."


class FakePublisher:
    def __init__(self):
        self.messages = []

    async def publish(self, topic, payload):
        self.messages.append((topic, payload))


def test_rag_query_uses_injected_runner_without_network():
    result = asyncio.run(
        answer_question(
            "What is Liftoff?",
            runner=FakeRunner(),
            tracer=DisabledTracer(),
        )
    )
    assert result == {
        "answer": "Liftoff is the generated orchestration starter.",
        "question": "What is Liftoff?",
        "citations": [],
    }


def test_rag_ingestion_uses_injected_publisher():
    publisher = FakePublisher()
    result = asyncio.run(
        enqueue_ingestion("az://documents/one.pdf", publisher=publisher)
    )
    assert result == {
        "status": "queued",
        "source_uri": "az://documents/one.pdf",
    }
    assert publisher.messages == [
        ("rag.ingest", {"source_uri": "az://documents/one.pdf"})
    ]


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)
    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(answer_question("unconfigured"))
`;
  }
  if (pattern.id === 'streaming') {
    return `import asyncio

import pytest

from ${agentModule} import stream_response
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "stream this" in prompt
        return "offline streamed answer"


def test_streaming_uses_injected_runner_without_network():
    async def collect():
        return [
            chunk
            async for chunk in stream_response(
                "stream this",
                runner=FakeRunner(),
                tracer=DisabledTracer(),
            )
        ]

    chunks = asyncio.run(collect())
    assert chunks == ['data: {"text": "offline streamed answer"}\\n\\n']


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)

    async def collect():
        return [chunk async for chunk in stream_response("unconfigured")]

    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(collect())
`;
  }
  return `import asyncio

import pytest

from ${agentModule} import run_${moduleName}
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "offline input" in prompt
        return "offline ${pattern.id} result"


def test_${moduleName}_uses_injected_runner_without_network():
    result = asyncio.run(
        run_${moduleName}(
            "offline input",
            runner=FakeRunner(),
            tracer=DisabledTracer(),
        )
    )
    assert result == {
        "result": "offline ${pattern.id} result",
        "input": "offline input",
    }


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)
    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(run_${moduleName}("unconfigured"))
`;
}

export function renderPromptTemplate(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  if (pattern.id === 'generic') {
    return `# Generic GenAI System Prompt

Respond safely and usefully to the general-purpose request.

Do not assume retrieval, conversation memory, tools, streaming, fine-tuning, multi-agent coordination, or workflow behavior unless the project explicitly adds it.
`;
  }
  return `# ${pattern.label} Prompt

You are implementing a ${pattern.label} generated by Mission Control Liftoff.

Use PydanticAI orchestration and return outputs that match the API contract.
`;
}

export function renderPromptReadme(): string {
  return `# Prompt Templates

These project-owned prompt files are editable design seeds. The generated runner does not load them.
Implement and test prompt loading in a separate reviewed project change before relying on their contents.
`;
}

export function renderVectorStore(): string {
  return `from typing import Protocol


class VectorStore(Protocol):
    async def search(self, query: str, limit: int = 5) -> list[dict]:
        ...


class PgVectorStore:
    async def search(self, query: str, limit: int = 5) -> list[dict]:
        raise NotImplementedError("pgvector retrieval is not implemented by this starter.")
`;
}

export function renderPatternWorker(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `async def run_worker() -> None:
    raise NotImplementedError("${pattern.id} job processing is a deferred project integration.")
`;
}
