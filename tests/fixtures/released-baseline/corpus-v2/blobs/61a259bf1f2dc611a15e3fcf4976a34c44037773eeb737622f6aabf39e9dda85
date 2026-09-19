export function renderPythonDotenvValidation(): string {
  return `def _validate_dotenv(text: str) -> None:
    position = 0
    length = len(text)

    def invalid(offset: int) -> None:
        line = text[:offset].count("\\n") + 1
        raise RuntimeError(f"Malformed runtime configuration at line {line}: expected KEY=value with balanced quotes.")

    if "\\0" in text:
        invalid(text.index("\\0"))
    while position < length:
        while position < length and text[position] in " \\t\\r\\n":
            position += 1
        if position == length:
            break
        start = position
        if text[position] == "#":
            while position < length and text[position] not in "\\r\\n":
                position += 1
            continue
        assignment = re.match(r"(?:export[ \\t]+)?[A-Za-z_][A-Za-z0-9_]*[ \\t]*=", text[position:])
        if assignment is None:
            invalid(start)
        position += assignment.end()
        while position < length and text[position] in " \\t":
            position += 1
        if position < length and text[position] in "\\"'":
            quote = text[position]
            position += 1
            while position < length and text[position] != quote:
                position += 2 if text[position] == "\\\\" else 1
            if position >= length:
                invalid(start)
            position += 1
            while position < length and text[position] in " \\t":
                position += 1
            if position < length and text[position] not in "#\\r\\n":
                invalid(start)
        while position < length and text[position] not in "\\r\\n":
            position += 1
`;
}

export function renderNodeDotenvValidation(): string {
  return `function validateDotenv(text: string): void {
  let position = 0;
  const invalid = (offset: number): never => {
    const line = text.slice(0, offset).split('\\n').length;
    throw new Error('Malformed runtime configuration at line ' + line + ': expected KEY=value with balanced quotes.');
  };
  if (text.includes('\\0')) invalid(text.indexOf('\\0'));
  while (position < text.length) {
    while (position < text.length && ' \\t\\r\\n'.includes(text[position])) position++;
    if (position === text.length) break;
    const start = position;
    if (text[position] === '#') {
      while (position < text.length && !'\\r\\n'.includes(text[position])) position++;
      continue;
    }
    const assignment = /^(?:export[ \\t]+)?[A-Za-z_][A-Za-z0-9_]*[ \\t]*=/.exec(text.slice(position));
    if (!assignment) invalid(start);
    position += assignment![0].length;
    while (position < text.length && ' \\t'.includes(text[position])) position++;
    if (position < text.length && (text[position] === '"' || text[position] === "'")) {
      const quote = text[position++];
      while (position < text.length && text[position] !== quote) {
        if (text[position] === '\\\\' && text[position + 1] === quote) invalid(start);
        position += text[position] === '\\\\' ? 2 : 1;
      }
      if (position >= text.length) invalid(start);
      position++;
      while (position < text.length && ' \\t'.includes(text[position])) position++;
      if (position < text.length && !'#\\r\\n'.includes(text[position])) invalid(start);
    }
    while (position < text.length && !'\\r\\n'.includes(text[position])) position++;
  }
}
`;
}
