/**
 * Cloud Logging exclusions on the project's `_Default` sink. Pure: no I/O.
 * `scripts/apply-log-exclusions.ts` reads the sink, plans with these, and
 * writes only with `--apply`.
 *
 * Invite links (`/invite/<token>`), collection links (`/c/<token>`), and
 * public collection links (the page `/p/<token>` and its reads under
 * `/api/public/<token>`) carry their secret in the path. `/privacy` promises
 * that request logs never hold a link, but Cloud Run's request log records
 * the full URL and the `Referer`. This exclusion drops those request lines
 * before they are stored. Every token kind is 20–64 characters of
 * `[A-Za-z0-9_-]` (`isInviteTokenShape` in `server/invites.ts`), so
 * `/c/join`, `/api/public/join`, and `/invite` without a token are still
 * logged.
 */

export interface LogExclusion {
  name: string;
  description?: string;
  filter: string;
  disabled?: boolean;
}

/** A link token in a URL's path. RE2 (Cloud Logging's `=~`) and JS read it the same way. */
export const LINK_TOKEN_URL = '^https?://[^/]+/(invite|c|p|api/public)/[A-Za-z0-9_-]{20}';

export const LINK_TOKEN_EXCLUSION: LogExclusion = {
  name: 'link-token-requests',
  description:
    'Cloud Run request lines whose URL or Referer holds an /invite/, /c/, /p/, or /api/public/ link token. See scripts/logExclusions.ts.',
  filter:
    `log_id("run.googleapis.com/requests") AND ` +
    `(httpRequest.requestUrl=~"${LINK_TOKEN_URL}" OR httpRequest.referer=~"${LINK_TOKEN_URL}")`,
};

export type ExclusionPlan =
  | { kind: 'in_place' }
  | { kind: 'add' | 'replace'; next: LogExclusion[] };

/** What to write so `wanted` is present and enabled, keeping every other exclusion. */
export function planExclusions(
  current: readonly LogExclusion[],
  wanted: LogExclusion = LINK_TOKEN_EXCLUSION,
): ExclusionPlan {
  const existing = current.find((exclusion) => exclusion.name === wanted.name);
  if (existing !== undefined && matches(existing, wanted)) {
    return { kind: 'in_place' };
  }
  const others = current.filter((exclusion) => exclusion.name !== wanted.name);
  return {
    kind: existing === undefined ? 'add' : 'replace',
    next: [...others, { ...wanted }],
  };
}

/** True when `after` holds `wanted` exactly once, enabled, and every other exclusion is unchanged. */
export function exclusionsApplied(
  before: readonly LogExclusion[],
  after: readonly LogExclusion[],
  wanted: LogExclusion = LINK_TOKEN_EXCLUSION,
): boolean {
  const ours = after.filter((exclusion) => exclusion.name === wanted.name);
  if (ours.length !== 1 || !matches(ours[0], wanted)) return false;
  const othersBefore = before.filter((exclusion) => exclusion.name !== wanted.name);
  const othersAfter = after.filter((exclusion) => exclusion.name !== wanted.name);
  return (
    othersBefore.length === othersAfter.length &&
    othersBefore.every((exclusion) =>
      othersAfter.some(
        (other) =>
          other.name === exclusion.name &&
          other.filter === exclusion.filter &&
          (other.disabled === true) === (exclusion.disabled === true),
      ),
    )
  );
}

function matches(exclusion: LogExclusion, wanted: LogExclusion): boolean {
  return exclusion.filter === wanted.filter && exclusion.disabled !== true;
}
