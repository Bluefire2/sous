import { describe, expect, it } from 'vitest';
import { runApplyLogExclusions, SINK_URL, type Sink, type SinkClient } from './apply-log-exclusions.ts';
import { LINK_TOKEN_EXCLUSION, type LogExclusion } from './logExclusions.ts';

const OTHER: LogExclusion = { name: 'health-checks', filter: 'httpRequest.requestUrl:"/healthz"' };

/** A fake Logging API over one stored sink. `afterPatch` can make the server misbehave. */
function fakeSink(initial: Sink, afterPatch?: (sink: Sink) => Sink) {
  let sink = structuredClone(initial);
  const requests: { url: string; method: string; data?: unknown }[] = [];
  const client: SinkClient = {
    async request<T>(options: { url: string; method?: string; data?: unknown }) {
      const method = options.method ?? 'GET';
      requests.push({ url: options.url, method, data: options.data });
      if (method === 'PATCH') {
        const patched = { ...sink, exclusions: (options.data as { exclusions: LogExclusion[] }).exclusions };
        sink = afterPatch ? afterPatch(patched) : patched;
      }
      return { data: structuredClone(sink) as T };
    },
  };
  return { client, requests, current: () => sink };
}

function quiet() {
  const out: string[] = [];
  const err: string[] = [];
  return { output: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

const base: Sink = {
  name: '_Default',
  destination: 'logging.googleapis.com/projects/p/locations/global/buckets/_Default',
  filter: 'NOT LOG_ID("cloudaudit")',
  exclusions: [OTHER],
};

describe('runApplyLogExclusions', () => {
  it('does nothing when the exclusion is already in place', async () => {
    const sink = fakeSink({ ...base, exclusions: [OTHER, { ...LINK_TOKEN_EXCLUSION }] });
    const q = quiet();
    expect(await runApplyLogExclusions(['--apply'], sink.client, q.output)).toBe(0);
    expect(sink.requests.map((r) => r.method)).toEqual(['GET']);
    expect(q.out.at(-1)).toBe('link-token-requests is already in place. Nothing to do.');
  });

  it('plans but never writes on a dry run', async () => {
    const sink = fakeSink(base);
    const q = quiet();
    expect(await runApplyLogExclusions([], sink.client, q.output)).toBe(0);
    expect(sink.requests.map((r) => r.method)).toEqual(['GET']);
    expect(q.out).toContain('Plan: add link-token-requests');
    expect(q.out.at(-1)).toBe('Dry run; pass --apply to write.');
  });

  it('patches only the exclusions, keeps the others, and verifies by reading back', async () => {
    const sink = fakeSink(base);
    const q = quiet();
    expect(await runApplyLogExclusions(['--apply'], sink.client, q.output)).toBe(0);
    expect(sink.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${SINK_URL}`,
      `PATCH ${SINK_URL}?updateMask=exclusions`,
      `GET ${SINK_URL}`,
    ]);
    expect(sink.requests[1].data).toEqual({ exclusions: [OTHER, LINK_TOKEN_EXCLUSION] });
    expect(sink.current().destination).toBe(base.destination);
    expect(q.err).toEqual([]);
  });

  it('replaces a disabled copy', async () => {
    const sink = fakeSink({ ...base, exclusions: [{ ...LINK_TOKEN_EXCLUSION, disabled: true }, OTHER] });
    const q = quiet();
    expect(await runApplyLogExclusions(['--apply'], sink.client, q.output)).toBe(0);
    expect(q.out).toContain('Plan: replace link-token-requests');
    expect(sink.current().exclusions).toEqual([OTHER, LINK_TOKEN_EXCLUSION]);
  });

  const broken: [string, (sink: Sink) => Sink][] = [
    ['the destination changed', (s) => ({ ...s, destination: 'storage.googleapis.com/other' })],
    ['the filter changed', (s) => ({ ...s, filter: '' })],
    ['the sink got disabled', (s) => ({ ...s, disabled: true })],
    ['a neighbouring exclusion was lost', (s) => ({ ...s, exclusions: [LINK_TOKEN_EXCLUSION] })],
    ['the new exclusion came back disabled', (s) => ({ ...s, exclusions: [OTHER, { ...LINK_TOKEN_EXCLUSION, disabled: true }] })],
  ];
  for (const [label, afterPatch] of broken) {
    it(`exits 1 when, after the write, ${label}`, async () => {
      const sink = fakeSink(base, afterPatch);
      const q = quiet();
      expect(await runApplyLogExclusions(['--apply'], sink.client, q.output)).toBe(1);
      expect(q.err).toEqual(['The sink does not have the expected shape after the update. Check it by hand.']);
    });
  }
});
