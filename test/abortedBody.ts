/**
 * A request body whose client hangs up mid-upload: some JSON, then the error
 * `Readable.toWeb(nodeReq)` raises when the connection closes (Node's
 * `Error('aborted')`, ECONNRESET). The error carries `secret` so a test can
 * prove it never reaches a log line.
 */
export function abortedBody(secret = 'SECRET-ABORT-DETAIL'): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"pastedText":"half a recipe'));
        return;
      }
      controller.error(Object.assign(new Error(`aborted ${secret}`), { code: 'ECONNRESET' }));
    },
  });
}

/** A JSON POST to `url` whose body is `abortedBody()`. */
export function abortedRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: abortedBody(),
    duplex: 'half',
  } as RequestInit);
}
