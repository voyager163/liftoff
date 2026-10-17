export interface TarMember { name: string; kind: string; content?: Buffer; target?: string; mode?: number }

function header(member: TarMember): Buffer {
  const bytes = Buffer.alloc(512);
  if (Buffer.byteLength(member.name) > 100) throw new Error('Use a GNU or PAX fixture for long paths.');
  bytes.write(member.name, 0, 100);
  const octal = (value: number, offset: number, length: number) =>
    bytes.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  octal(member.mode ?? 0o755, 100, 8);
  octal(0, 108, 8); octal(0, 116, 8);
  octal(member.content?.length ?? 0, 124, 12); octal(0, 136, 12);
  bytes.fill(32, 148, 156);
  bytes.write(member.kind, 156, 1);
  bytes.write(member.target ?? '', 157, 100);
  bytes.write('ustar\0', 257, 6); bytes.write('00', 263, 2);
  octal(bytes.reduce((sum, byte) => sum + byte, 0), 148, 8);
  return bytes;
}

export function tar(members: TarMember[]): Buffer {
  return Buffer.concat([...members.flatMap(member => {
    const content = member.content ?? Buffer.alloc(0);
    return [header(member), content, Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length)];
  }), Buffer.alloc(1024)]);
}

export function paxRecord(name: string, value: string) {
  const body = `${name}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  for (;;) {
    const next = Buffer.byteLength(body) + String(length).length + 1;
    if (next === length) return Buffer.from(`${length} ${body}`);
    length = next;
  }
}
