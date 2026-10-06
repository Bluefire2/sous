/**
 * A request body that never ends: a route that reads it whole never answers.
 * Body-cap tests use it to prove a route stops reading (and cancels) past its
 * limit instead of buffering forever.
 */
export function endlessBody(): { body: ReadableStream<Uint8Array>; read: () => number; cancelled: () => boolean } {
  let bytes = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = new Uint8Array(64 * 1024).fill(0x20);
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, read: () => bytes, cancelled: () => cancelled };
}
