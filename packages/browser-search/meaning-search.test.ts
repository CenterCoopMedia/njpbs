import { describe, it, expect } from 'vitest';
import { createMeaningRuntime } from './runtime';
import { createMeaningSearch } from './index';
import { chunkText, fuseRanks, normalize, rankVectors } from './math';
import { DIMENSIONS, MAX_CHUNKS, MAX_DOCUMENTS, QUERY_PREFIX, type MeaningResponse, type MeaningRequest } from './contracts';

const vector = (index = 0) => Float32Array.from({ length: DIMENSIONS }, (_, i) => i === index ? 1 : 0);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function harness(encode = async (_text: string) => vector()) {
  const messages: MeaningResponse[] = [];
  let loads = 0;
  const receive = createMeaningRuntime(async () => { loads++; return encode; }, message => messages.push(message));
  return { receive, messages, loads: () => loads, result: (id: number) => messages.find(message => message.id === id && message.type !== 'progress') };
}

describe('meaning search contracts', () => {
  it('bounds passage chunks and rejects invalid vectors', () => {
    expect(chunkText('x'.repeat(100000))).toHaveLength(MAX_CHUNKS);
    expect(chunkText('')).toEqual([]);
    expect(() => normalize(new Float32Array(DIMENSIONS))).toThrow('invalid_vector');
    expect(() => normalize([1, 2])).toThrow('invalid_vector');
    const bad = vector(); bad[1] = NaN;
    expect(() => normalize(bad)).toThrow('invalid_vector');
  });
  it('fuses union ranks and counts repeated keyword hits once', () => {
    expect(fuseRanks(['a', 'a', 'b'], ['b', 'c'])).toEqual(['b', 'a', 'c']);
    expect(rankVectors(new Map([['a', { vector: vector() }], ['b', { vector: vector(1) }]]), vector(), 25, 0.5)).toEqual([{ id: 'a', score: 1 }]);
  });
  it('uses precomputed vectors without document inference and prefixes query inference', async () => {
    const texts: string[] = [];
    const h = harness(async text => { texts.push(text); return vector(); });
    h.receive({ id: 1, type: 'start' });
    h.receive({ id: 2, type: 'prepare', documents: [{ id: 'public', text: 'Title', vector: [...vector()] }] });
    h.receive({ id: 3, type: 'search', query: 'question', options: {} });
    await flush();
    expect(h.loads()).toBe(1);
    expect(texts).toEqual([QUERY_PREFIX + 'question']);
    expect(h.result(3)).toEqual({ id: 3, type: 'result', value: [{ id: 'public', score: 1 }] });
  });
  it('reuses unchanged documents but removes deleted IDs', async () => {
    const texts: string[] = [];
    const h = harness(async text => { texts.push(text); return vector(); });
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] });
    await flush();
    h.receive({ id: 2, type: 'prepare', documents: [{ id: 'a', text: 'one' }] });
    h.receive({ id: 3, type: 'search', query: 'find', options: {} });
    await flush();
    expect(texts).toEqual(['one', 'two', QUERY_PREFIX + 'find']);
    expect(h.result(3)).toEqual({ id: 3, type: 'result', value: [{ id: 'a', score: 1 }] });
  });
  it('reuses question inference while ranking only the current corpus', async () => {
    const texts: string[] = [];
    const h = harness(async text => { texts.push(text); return vector(); });
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'old', text: 'old', vector: [...vector()] }] });
    await flush();
    h.receive({ id: 2, type: 'search', query: ' question ', options: {} });
    await flush();
    h.receive({ id: 3, type: 'prepare', documents: [{ id: 'new', text: 'new', vector: [...vector()] }] });
    await flush();
    h.receive({ id: 4, type: 'search', query: 'question', options: {} });
    await flush();
    expect(h.result(4)).toEqual({ id: 4, type: 'result', value: [{ id: 'new', score: 1 }] });
    h.receive({ id: 5, type: 'prepare', documents: [] });
    await flush();
    h.receive({ id: 6, type: 'search', query: 'question', options: {} });
    await flush();
    expect(h.result(6)).toEqual({ id: 6, type: 'result', value: [] });
    expect(texts).toEqual([QUERY_PREFIX + 'question']);
  });
  it('bounds question vectors and evicts the least recently used question', async () => {
    const texts: string[] = [];
    const h = harness(async text => { texts.push(text); return vector(); });
    h.receive({ id: 1, type: 'prepare', documents: [] });
    await flush();
    let id = 1;
    for (let query = 0; query < 32; query++) {
      h.receive({ id: ++id, type: 'search', query: String(query), options: {} });
      await flush();
    }
    for (const query of ['0', '32', '0', '1']) {
      h.receive({ id: ++id, type: 'search', query, options: {} });
      await flush();
    }
    expect(texts.filter(text => text === QUERY_PREFIX + '0')).toHaveLength(1);
    expect(texts.filter(text => text === QUERY_PREFIX + '1')).toHaveLength(2);
    expect(texts).toHaveLength(34);
  });
  it('reuses a vector for a document that returns with the same text after a narrower prepare', async () => {
    const texts: string[] = [];
    const h = harness(async text => { texts.push(text); return vector(); });
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] });
    await flush();
    h.receive({ id: 2, type: 'prepare', documents: [{ id: 'a', text: 'one' }] });
    await flush();
    h.receive({ id: 3, type: 'prepare', documents: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }, { id: 'c', text: 'three' }] });
    await flush();
    h.receive({ id: 4, type: 'prepare', documents: [{ id: 'b', text: 'changed' }] });
    await flush();
    expect(texts).toEqual(['one', 'two', 'three', 'changed']);
    expect(h.result(3)).toEqual({ id: 3, type: 'result', value: { count: 3, encoded: 1 } });
    expect(h.result(4)).toEqual({ id: 4, type: 'result', value: { count: 1, encoded: 1 } });
  });
  it('serializes model operations and skips superseded queued queries', async () => {
    let release: (() => void) | undefined;
    let active = 0;
    let maximum = 0;
    const texts: string[] = [];
    const h = harness(async text => {
      maximum = Math.max(maximum, ++active); texts.push(text);
      if (text.endsWith('first')) await new Promise<void>(resolve => { release = resolve; });
      active--; return vector();
    });
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'a', text: 'a', vector: [...vector()] }] }); await flush();
    h.receive({ id: 2, type: 'search', query: 'first', options: {} }); await flush();
    h.receive({ id: 3, type: 'search', query: 'second', options: {} });
    h.receive({ id: 4, type: 'search', query: 'third', options: {} });
    release?.(); await flush();
    expect(maximum).toBe(1);
    expect(texts).toEqual([QUERY_PREFIX + 'first', QUERY_PREFIX + 'third']);
    expect(h.result(2)).toEqual({ id: 2, type: 'error', code: 'superseded' });
    expect(h.result(3)).toEqual({ id: 3, type: 'error', code: 'superseded' });
    expect(h.result(4)?.type).toBe('result');
  });
  it('rejects duplicate IDs and overlarge corpora before inference', async () => {
    const h = harness();
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }] }); await flush();
    expect(h.result(1)).toEqual({ id: 1, type: 'error', code: 'invalid_documents' });
    h.receive({ id: 2, type: 'prepare', documents: Array(MAX_DOCUMENTS + 1).fill({ id: 'a', text: 'a' }) }); await flush();
    expect(h.result(2)).toEqual({ id: 2, type: 'error', code: 'invalid_documents' });
    expect(h.loads()).toBe(0);
  });
  it('retries model initialization after a failure', async () => {
    let attempts = 0;
    const messages: MeaningResponse[] = [];
    const receive = createMeaningRuntime(async () => { if (++attempts === 1) throw Error('provider detail'); return async () => vector(); }, message => messages.push(message));
    receive({ id: 1, type: 'start' }); await flush();
    receive({ id: 2, type: 'start' }); await flush();
    expect(messages).toEqual([{ id: 1, type: 'error', code: 'model_unavailable' }, { id: 2, type: 'result', value: undefined }]);
  });
  it('drops pending main-thread queries without terminating the loaded model; disposal terminates it', async () => {
    const sent: MeaningRequest[] = [];
    let terminated = 0;
    const client = createMeaningSearch({ workerFactory: () => ({ postMessage: request => sent.push(request), addEventListener: () => {}, terminate: () => { terminated++; } }) });
    const first = client.search('one').catch(error => error.name);
    const second = client.search('two').catch(error => error.name);
    expect(await first).toBe('AbortError');
    expect(terminated).toBe(0);
    client.dispose();
    expect(await second).toBe('AbortError');
    expect(terminated).toBe(1);
    await expect(client.start()).rejects.toThrow('search_disposed');
    expect(sent).toHaveLength(2);
  });
  it('never returns an old query after corpus replacement', async () => {
    let release: (() => void) | undefined;
    const h = harness(async () => { await new Promise<void>(resolve => { release = resolve; }); return vector(); });
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'old', text: 'old', vector: [...vector()] }] }); await flush();
    h.receive({ id: 2, type: 'search', query: 'question', options: {} }); await flush();
    h.receive({ id: 3, type: 'prepare', documents: [] });
    release?.(); await flush();
    expect(h.result(2)).toEqual({ id: 2, type: 'result', value: [] });
    expect(h.result(3)).toEqual({ id: 3, type: 'result', value: { count: 0, encoded: 0 } });
  });

  it('returns a fixed error code without forwarding model input or provider details', async () => {
    const h = harness(async () => { throw Error('private_interview_text'); });
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'a', text: 'private passage' }] }); await flush();
    expect(h.result(1)).toEqual({ id: 1, type: 'error', code: 'search_unavailable' });
  });

  it('answers a question between incremental passage encodes on the completed index', async () => {
    let release: (() => void) | undefined;
    const texts: string[] = [];
    const h = harness(async text => {
      texts.push(text);
      if (text === 'first new passage') await new Promise<void>(resolve => { release = resolve; });
      return vector();
    });
    const existing = { id: 'old', text: 'existing', vector: [...vector()] };
    h.receive({ id: 1, type: 'prepare', documents: [existing] }); await flush();
    h.receive({ id: 2, type: 'prepare', documents: [existing, { id: 'new1', text: 'first new passage' }, { id: 'new2', text: 'second new passage' }] }); await flush();
    h.receive({ id: 3, type: 'search', query: 'find', options: {} });
    release?.(); await flush();
    expect(texts).toEqual(['first new passage', QUERY_PREFIX + 'find', 'second new passage']);
    expect(h.result(3)).toEqual({ id: 3, type: 'result', value: [{ id: 'old', score: 1 }] });
    expect(h.messages.indexOf(h.result(3)!)).toBeLessThan(h.messages.indexOf(h.result(2)!));
  });

  it('withholds a same-ID changed document while its replacement encodes', async () => {
    let release: (() => void) | undefined;
    const h = harness(async text => {
      if (text === 'changed') await new Promise<void>(resolve => { release = resolve; });
      return vector();
    });
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'a', text: 'old', vector: [...vector()] }] }); await flush();
    h.receive({ id: 2, type: 'search', query: 'question', options: {} });
    h.receive({ id: 3, type: 'prepare', documents: [{ id: 'a', text: 'changed' }] }); await flush();
    expect(h.result(2)).toEqual({ id: 2, type: 'result', value: [] });
    release?.(); await flush();
  });
  it('withholds a same-ID replacement vector before the queued query runs', async () => {
    const h = harness();
    h.receive({ id: 1, type: 'prepare', documents: [{ id: 'a', text: 'same', vector: [...vector()] }] }); await flush();
    h.receive({ id: 2, type: 'search', query: 'question', options: {} });
    h.receive({ id: 3, type: 'prepare', documents: [{ id: 'a', text: 'same', vector: [...vector(1)] }] }); await flush();
    expect(h.result(2)).toEqual({ id: 2, type: 'result', value: [] });
  });

});
