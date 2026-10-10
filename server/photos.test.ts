import { describe, expect, it } from 'vitest';
import {
  assertPhotoId,
  isAllowedPhotoContentType,
  isPhotoByteCountTooLarge,
  isPhotoContentLengthTooLarge,
  MAX_PHOTO_BYTES,
  photoBytesFromResponse,
  photoUploadDecision,
  photoUploadStopsAtLiveReplay,
  planUploadIntent,
  readCappedBytes,
} from './photos.ts';

describe('assertPhotoId', () => {
  it('rejects non-uuid paths', () => {
    expect(assertPhotoId('not-a-uuid')).toBe(false);
    expect(assertPhotoId('../escape')).toBe(false);
    expect(assertPhotoId('')).toBe(false);
  });

  it('accepts uuid', () => {
    expect(assertPhotoId('11111111-1111-4111-8111-111111111111')).toBe(true);
  });
});

describe('photoUploadDecision', () => {
  it('allows idempotent replay on live docs at equal timestamp', () => {
    expect(photoUploadDecision({ updatedAt: 5 }, 5)).toEqual({
      allow: true,
      undeleting: false,
    });
  });

  it('tombstone wins against put at equal timestamp', () => {
    expect(photoUploadDecision({ updatedAt: 5, deletedAt: 5 }, 5)).toEqual({
      allow: false,
      reason: 'already-deleted',
    });
  });
});

describe('photoUploadStopsAtLiveReplay', () => {
  it('stops intent for live photos regardless of client timestamp', () => {
    expect(
      photoUploadStopsAtLiveReplay({
        status: 'live',
        updatedAt: 100,
        recipeId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(true);
  });

  it('does not stop for uploading or missing metadata', () => {
    expect(photoUploadStopsAtLiveReplay(undefined)).toBe(false);
    expect(
      photoUploadStopsAtLiveReplay({ status: 'uploading', updatedAt: 1 }),
    ).toBe(false);
    expect(
      photoUploadStopsAtLiveReplay({ status: 'live', updatedAt: 1, deletedAt: 1 }),
    ).toBe(false);
  });
});

describe('isAllowedPhotoContentType', () => {
  it('allows jpeg and png', () => {
    expect(isAllowedPhotoContentType('image/jpeg')).toBe(true);
    expect(isAllowedPhotoContentType('image/png')).toBe(true);
    expect(isAllowedPhotoContentType('image/jpeg; charset=binary')).toBe(true);
  });

  it('rejects other types', () => {
    expect(isAllowedPhotoContentType('image/webp')).toBe(false);
    expect(isAllowedPhotoContentType('application/octet-stream')).toBe(false);
  });
});

describe('photo body size predicates', () => {
  it('flags content-length over 2 MB before upload', () => {
    expect(isPhotoContentLengthTooLarge(null)).toBe(false);
    expect(isPhotoContentLengthTooLarge(MAX_PHOTO_BYTES)).toBe(false);
    expect(isPhotoContentLengthTooLarge(MAX_PHOTO_BYTES + 1)).toBe(true);
  });

  it('flags streamed byte counts over 2 MB', () => {
    expect(isPhotoByteCountTooLarge(MAX_PHOTO_BYTES)).toBe(false);
    expect(isPhotoByteCountTooLarge(MAX_PHOTO_BYTES + 1)).toBe(true);
  });
});

describe('readCappedBytes', () => {
  it('returns the body when it fits in the cap', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const result = await readCappedBytes(body, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.bytes]).toEqual([1, 2, 3]);
    }
  });

  it('cancels a body that exceeds the cap', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await readCappedBytes(body, 1500);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  });
});

describe('photoBytesFromResponse', () => {
  it('treats 404 as missing and other errors as failed', async () => {
    expect(await photoBytesFromResponse(new Response(null, { status: 404 }), 10)).toEqual({
      kind: 'missing',
    });
    expect(await photoBytesFromResponse(new Response('nope', { status: 503 }), 10)).toEqual({
      kind: 'failed',
      status: 503,
    });
  });

  it('rejects a declared length over the cap without reading the body', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { 'Content-Length': String(MAX_PHOTO_BYTES + 1) },
    });
    expect(await photoBytesFromResponse(response, MAX_PHOTO_BYTES)).toEqual({ kind: 'too-large' });
    expect(pulled).toBe(false);
  });

  it('returns bytes that fit', async () => {
    const response = new Response(new Uint8Array([4, 5]), { status: 200 });
    const result = await photoBytesFromResponse(response, MAX_PHOTO_BYTES);
    expect(result.kind).toBe('bytes');
    if (result.kind === 'bytes') {
      expect([...result.bytes]).toEqual([4, 5]);
    }
  });
});

describe('planUploadIntent', () => {
  const RECIPE = '11111111-1111-4111-8111-111111111111';

  it('accepts a revived id after its tombstone and drops the queued object delete', () => {
    expect(planUploadIntent(true, { id: 'p', updatedAt: 10, deletedAt: 10 }, 11)).toEqual({
      kind: 'proceed',
      clearQueuedGcsDelete: true,
    });
  });

  it('accepts a new id and a retried uploading id', () => {
    expect(planUploadIntent(true, undefined, 1)).toEqual({
      kind: 'proceed',
      clearQueuedGcsDelete: true,
    });
    expect(planUploadIntent(true, { status: 'uploading', updatedAt: 5 }, 5)).toEqual({
      kind: 'proceed',
      clearQueuedGcsDelete: true,
    });
  });

  it('leaves the queue alone when the upload is not accepted', () => {
    expect(planUploadIntent(false, undefined, 1)).toEqual({
      kind: 'conflict',
      error: 'recipe-deleted',
    });
    expect(planUploadIntent(true, { updatedAt: 10, deletedAt: 10 }, 10)).toEqual({
      kind: 'conflict',
      error: 'already-deleted',
    });
    expect(planUploadIntent(true, { status: 'uploading', updatedAt: 10 }, 9)).toEqual({
      kind: 'conflict',
      error: 'stale',
    });
    expect(
      planUploadIntent(true, { status: 'live', updatedAt: 10, recipeId: RECIPE }, 1),
    ).toEqual({ kind: 'stop' });
  });
});
