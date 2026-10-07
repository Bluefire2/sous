import { invalidateSession } from './session';

/**
 * Whether this account has closed the new-member intro
 * (`docs/plans/new-member-intro.md`). The server keeps it on the profile, so
 * it holds on every device.
 *
 * Per page load and per `sub`, the server is asked at most once: the answer
 * (or `null` for unknown) is kept here, and closing the intro records `true`
 * before the POST, so a failed write can't reopen it until the next load.
 */
const answers = new Map<string, Promise<boolean | null>>();

/** `GET /api/intro`. `null` means unknown: offline, 503, or a bad body. */
export async function fetchIntroSeen(): Promise<boolean | null> {
  let response: Response;
  try {
    response = await fetch('/api/intro', { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return null;
  }
  if (response.status === 401) {
    invalidateSession();
    return null;
  }
  if (!response.ok) return null;
  try {
    const body = (await response.json()) as { seen?: unknown };
    return typeof body.seen === 'boolean' ? body.seen : null;
  } catch {
    return null;
  }
}

/** Whether `sub` has closed the intro, asking the server once per page load. */
export function introSeenFor(sub: string): Promise<boolean | null> {
  let answer = answers.get(sub);
  if (answer === undefined) {
    answer = fetchIntroSeen();
    answers.set(sub, answer);
  }
  return answer;
}

/**
 * Records that `sub` closed the intro. The POST's result is ignored: the
 * worst case of a lost write is that the intro shows once more on a later
 * visit.
 */
export function markIntroSeen(sub: string): void {
  answers.set(sub, Promise.resolve(true));
  void fetch('/api/intro/seen', { method: 'POST', credentials: 'same-origin' }).then(
    (response) => {
      if (response.status === 401) invalidateSession();
    },
    () => {},
  );
}

/** Test isolation. */
export function resetIntroAnswersForTests(): void {
  answers.clear();
}
