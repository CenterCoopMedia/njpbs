/** Bound network input before buffering; never include payloads or URLs in errors. */
export async function readBody(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Response exceeds budget');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export function requestSignal(timeoutMs: number, stop?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return stop ? AbortSignal.any([stop, timeout]) : timeout;
}
