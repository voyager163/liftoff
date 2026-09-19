import { createHash } from 'node:crypto';

export function isRecord(value         )                                   {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalValue(value         )          {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical JSON cannot encode non-finite numbers.');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry));
  }
  if (typeof value === 'object') {
    const record = value                           ;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw new Error(`Canonical JSON cannot encode undefined field ${key}.`);
        }
        return [key, canonicalValue(entry)];
      })
    );
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}.`);
}

export function canonicalJson(value         )         {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function sha256Hex(value        )         {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalSha256(value         )         {
  return sha256Hex(canonicalJson(value));
}
