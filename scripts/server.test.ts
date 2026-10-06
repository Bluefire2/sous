import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isRequestAbort, pipeResponseBody } from './server.ts';

function goneClient(): Writable {
  const client = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  client.destroy();
  return client;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('pipeResponseBody', () => {
  it('cancels the body when the client left before piping started', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await pipeResponseBody(body, goneClient());
    await settle();
    expect(cancelled).toBe(true);
  });

  it('cancels the body when the client hangs up mid-response', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new Writable({
      write() {
        client.destroy();
      },
    });
    await expect(pipeResponseBody(body, client)).rejects.toMatchObject({
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    });
    await settle();
    expect(cancelled).toBe(true);
  });

  // The dev API server crash: a GCS read stream behind the body failed with
  // `aborted` after the client had gone, on a stream nothing listened to.
  it('leaves no unlistened error when the upstream fails after the client left', async () => {
    const upstream = new PassThrough();
    upstream.write(Buffer.alloc(16));
    const body = Readable.toWeb(upstream) as ReadableStream<Uint8Array>;
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      await pipeResponseBody(body, goneClient());
      upstream.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      await settle();
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
    expect(upstream.destroyed).toBe(true);
  });
});

describe('isRequestAbort', () => {
  it('is true only for a request destroyed before it finished arriving', () => {
    expect(isRequestAbort({ destroyed: true, complete: false })).toBe(true);
    // The whole request arrived; whatever failed after that is the server's.
    expect(isRequestAbort({ destroyed: true, complete: true })).toBe(false);
    // Still arriving, still connected.
    expect(isRequestAbort({ destroyed: false, complete: false })).toBe(false);
    expect(isRequestAbort({ destroyed: false, complete: true })).toBe(false);
  });
});
