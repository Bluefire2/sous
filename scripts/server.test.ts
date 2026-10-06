import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isClientHangUp, isRequestAbort, pipeFile, pipeResponseBody } from './server.ts';

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

describe('isClientHangUp', () => {
  it('reads a closed or vanished client as a hang-up', () => {
    expect(isClientHangUp(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))).toBe(true);
    expect(isClientHangUp(Object.assign(new Error('Cannot pipe'), { code: 'ERR_STREAM_UNABLE_TO_PIPE' }))).toBe(true);
  });

  it('reads anything else as a failure', () => {
    expect(isClientHangUp(Object.assign(new Error('no file'), { code: 'ENOENT' }))).toBe(false);
    expect(isClientHangUp(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isClientHangUp(new Error('boom'))).toBe(false);
    expect(isClientHangUp(null)).toBe(false);
    expect(isClientHangUp(undefined)).toBe(false);
  });

  it('matches what pipeResponseBody rejects with when the client hangs up', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const client = new Writable({
      write() {
        client.destroy();
      },
    });
    const err = await pipeResponseBody(body, client).then(() => null, (e: unknown) => e);
    expect(isClientHangUp(err)).toBe(true);
  });
});

function endlessFile(): Readable {
  return new Readable({
    read() {
      this.push(Buffer.alloc(1024));
    },
  });
}

describe('pipeFile', () => {
  it('does not open the file when the client left before piping started', async () => {
    let opened = false;
    await pipeFile(() => {
      opened = true;
      return endlessFile();
    }, goneClient());
    expect(opened).toBe(false);
  });

  it('resolves and closes the file when the client hangs up mid-file', async () => {
    const file = endlessFile();
    const client = new Writable({
      write() {
        client.destroy();
      },
    });
    await expect(pipeFile(() => file, client)).resolves.toBeUndefined();
    await settle();
    expect(file.destroyed).toBe(true);
  });

  it('rejects with a read error', async () => {
    const readError = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    const file = new Readable({
      read() {
        this.destroy(readError);
      },
    });
    const client = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    await expect(pipeFile(() => file, client)).rejects.toBe(readError);
  });

  it('sends the whole file to a client that stays', async () => {
    const chunks: Buffer[] = [];
    const client = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    await pipeFile(() => Readable.from([Buffer.from('<!doctype '), Buffer.from('html>')]), client);
    expect(Buffer.concat(chunks).toString()).toBe('<!doctype html>');
    expect(client.writableFinished).toBe(true);
  });
});
