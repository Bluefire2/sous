import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { createMemberInvite } from './inviteApi';
import { invalidateSession } from './session';

vi.mock('./session', () => ({ invalidateSession: vi.fn() }));

function respond(status: number, body?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      body === undefined
        ? new Response(null, { status })
        : new Response(typeof body === 'string' ? body : JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
    ),
  );
}

beforeEach(() => {
  vi.mocked(invalidateSession).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMemberInvite', () => {
  it('posts to /api/invites and returns the url', async () => {
    respond(200, { url: 'https://sous.example/invite/abc' });
    expect(await createMemberInvite()).toEqual({ url: 'https://sous.example/invite/abc' });
    const [path, init] = vi.mocked(fetch).mock.calls[0];
    expect(path).toBe('/api/invites');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  });

  it('signs out on 401 and asks the person to sign in again', async () => {
    respond(401, { error: 'Unauthorized' });
    await expect(createMemberInvite()).rejects.toThrow(t('error.sessionExpired'));
    expect(invalidateSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the session on 503 and says invitations are unavailable', async () => {
    respond(503, { error: 'Membership unavailable' });
    await expect(createMemberInvite()).rejects.toThrow(t('error.adminUnavailable'));
    expect(invalidateSession).not.toHaveBeenCalled();
  });

  it('shows the server sentence for another refusal, with its code', async () => {
    respond(409, { code: 'some-new-code', error: 'You have already invited five people.' });
    const error = await createMemberInvite().then(
      () => {
        throw new Error('expected a refusal');
      },
      (e: unknown) => e as Error & { code?: string },
    );
    expect(error.message).toBe('You have already invited five people.');
    expect(error.code).toBe('some-new-code');
  });

  it('falls back to the status line for a body it cannot read', async () => {
    respond(500, 'not json');
    await expect(createMemberInvite()).rejects.toThrow(t('error.requestFailed', { status: 500 }));
  });

  it('rejects a 200 without a usable url', async () => {
    for (const body of [{}, { url: '' }, { url: 42 }, 'not json']) {
      respond(200, body);
      await expect(createMemberInvite(), JSON.stringify(body)).rejects.toThrow(
        t('error.requestFailed', { status: 200 }),
      );
    }
    expect(invalidateSession).not.toHaveBeenCalled();
  });
});
