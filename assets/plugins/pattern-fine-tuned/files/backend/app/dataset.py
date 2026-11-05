"""Checks training data for chat fine-tuning before it is uploaded.

The format is JSON Lines: one conversation per line, as
``{"messages": [{"role": "...", "content": "..."}, ...]}``. Roles are
``system``, ``user`` and ``assistant``; a system message may only come first,
and each conversation needs a user message and ends with the assistant's.

Run it with: uv run python -m app.dataset datasets/example.jsonl
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path

ROLES = ("system", "user", "assistant")


def check_conversation(value: object) -> str | None:
    """What is wrong with one line's conversation, or None."""
    if not isinstance(value, dict) or set(value) != {"messages"}:
        return 'expected an object with only "messages"'
    messages = value["messages"]
    if not isinstance(messages, list) or not messages:
        return '"messages" must be a non-empty list'
    roles: list[str] = []
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            return 'each message needs exactly "role" and "content"'
        if message["role"] not in ROLES:
            return f"unknown role {message['role']!r}"
        if not isinstance(message["content"], str) or not message["content"].strip():
            return "each message needs some text"
        roles.append(message["role"])
    if "system" in roles[1:]:
        return "a system message may only come first"
    if "user" not in roles or roles[-1] != "assistant":
        return "a conversation needs a user message and ends with the assistant's"
    return None


def check(lines: Iterable[str]) -> tuple[int, list[str]]:
    """The number of conversations, and each problem with its line number."""
    count = 0
    problems: list[str] = []
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        count += 1
        try:
            problem = check_conversation(json.loads(line))
        except json.JSONDecodeError as error:
            problem = f"not JSON: {error.msg}"
        if problem:
            problems.append(f"line {number}: {problem}")
    if count == 0:
        problems.append("no conversations")
    return count, problems


def main(arguments: Sequence[str] | None = None) -> int:
    paths = list(sys.argv[1:] if arguments is None else arguments)
    if not paths:
        print("usage: python -m app.dataset FILE.jsonl ...", file=sys.stderr)
        return 2
    failed = False
    for path in paths:
        with Path(path).open(encoding="utf-8") as file:
            count, problems = check(file)
        for problem in problems:
            print(f"{path}: {problem}", file=sys.stderr)
        if problems:
            failed = True
        else:
            print(f"{path}: {count} conversations, no problems")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
