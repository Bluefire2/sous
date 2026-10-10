import { recordAccessRequest } from './members.ts';
import { readBoundedText } from './membership.ts';
import { sendMail } from './mail.ts';
import { verifyAccessRequestTx } from './session.ts';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Visual language follows public/privacy.html: one inline <style> block,
// system font stack, the same light/dark colour pairs, no external requests
// and no <script>. These pages are served to people who are not signed in,
// so they must be fully self-contained.
const PAGE_STYLES = `
:root {
  color-scheme: light dark;
}
body {
  max-width: 42rem;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica,
    Arial, sans-serif;
  line-height: 1.65;
  overflow-wrap: break-word;
  background: #fafaf9;
  color: #1c1917;
}
h1 {
  margin: 0 0 0.25rem;
  font-size: 1.625rem;
  line-height: 1.3;
}
p {
  margin: 0.5rem 0;
}
a {
  color: inherit;
}
.muted {
  opacity: 0.7;
}
form {
  margin: 1.25rem 0;
}
button,
a.action {
  font: inherit;
  padding: 0.5rem 1.25rem;
  border: none;
  border-radius: 0.375rem;
  background: #1c1917;
  color: #fafaf9;
  cursor: pointer;
}
a.action {
  display: inline-block;
  text-decoration: none;
}
button:hover,
a.action:hover {
  opacity: 0.85;
}
button:focus-visible,
a.action:focus-visible {
  outline: 2px solid #1c1917;
  outline-offset: 2px;
}
footer {
  margin-top: 3rem;
  font-size: 0.875rem;
  opacity: 0.7;
}
@media (prefers-color-scheme: dark) {
  body {
    background: #1c1917;
    color: #e7e5e4;
  }
  button,
  a.action {
    background: #e7e5e4;
    color: #1c1917;
  }
  button:focus-visible,
  a.action:focus-visible {
    outline-color: #e7e5e4;
  }
}
`;

/** A complete self-contained page in this style. Escape every interpolated value in `body`. */
export function pageHtml(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${PAGE_STYLES}</style></head>` +
    `<body>${body}</body></html>`
  );
}

function htmlPage(title: string, body: string, status: number): Response {
  return new Response(pageHtml(title, body), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// The 403 shown by the OAuth callback when the signed-in identity is not a
// member. `requestToken` is null when the token could not be minted — the
// page then renders without the form rather than with a broken button.
export function invitationOnlyPage(
  identity: { email: string; name?: string },
  requestToken: string | null,
): string {
  const signedInAs =
    identity.name !== undefined && identity.name !== ''
      ? `You signed in as ${escapeHtml(identity.name)} (${escapeHtml(identity.email)}).`
      : `You signed in as ${escapeHtml(identity.email)}.`;
  // Approval emails the requester, and signing in again works once they
  // are approved. The no-form copy says the request could not be started
  // and that retrying sign-in will offer it again — a mint failure is
  // transient.
  const requestBlock =
    requestToken === null
      ? '<p class="muted">Your request could not be started right now — ' +
        'signing in again will offer it once more. Once you have been ' +
        "approved, we'll email you, and you can try signing in again.</p>"
      : '<form method="POST" action="/api/access-request">' +
        `<input type="hidden" name="t" value="${escapeHtml(requestToken)}">` +
        '<button type="submit">Request access</button>' +
        '</form>' +
        '<p class="muted">Your request goes to the owner of this app. ' +
        "Once it is approved, we'll email you, and you can sign in again.</p>";
  return pageHtml(
    'Invitation only',
    '<h1>Sous is invitation-only</h1>' +
      `<p>${signedInAs}</p>` +
      requestBlock +
      '<footer><a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>',
  );
}

function expiredPage(): Response {
  return htmlPage(
    'Link expired',
    '<h1>Link expired</h1>' +
      '<p>That link has expired. Sign in again to request access.</p>' +
      '<p><a href="/">Home</a></p>',
    400,
  );
}

// A declined request is not re-sent to the owner, so its page keeps the
// pre-approval-email copy and promises nothing.
function recordedPageBody(promiseEmail: boolean): string {
  const promise = promiseEmail ? " Once it is approved, we'll email you." : '';
  return `<h1>Request sent</h1><p>Your request was recorded.${promise}</p>`;
}

export function recordedPageHtml(promiseEmail: boolean): string {
  return pageHtml('Request sent', recordedPageBody(promiseEmail));
}

function recordedPage(promiseEmail: boolean): Response {
  return htmlPage('Request sent', recordedPageBody(promiseEmail), 200);
}

function alreadyApprovedPage(): Response {
  return htmlPage(
    'Already approved',
    '<h1>Already approved</h1><p>You already have access — try signing in again.</p>',
    200,
  );
}

// Shared with the OAuth callback's Firestore-error branch in server/auth.ts,
// which wraps this HTML in its own response (it must also clear the oauth
// cookie, so it cannot reuse htmlPage's Response).
export function unavailablePageHtml(): string {
  return pageHtml(
    'Unavailable',
    '<h1>Unavailable</h1>' +
      '<p>Sign-in is temporarily unavailable. Try again in a few minutes.</p>',
  );
}

export type InviteDeadReason = 'malformed' | 'expired' | 'used' | 'revoked' | 'unknown';

export function inviteJoinPageHtml(): string {
  return pageHtml(
    'Join Sous',
    '<h1>You have been invited to Sous</h1>' +
      '<p>Sign in with Google to join. This link works once, for one person, ' +
      'and expires after 7 days.</p>' +
      '<p><a class="action" href="/api/auth/start">Sign in with Google</a></p>' +
      '<footer><a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>',
  );
}

export function inviteDeadPageHtml(reason: InviteDeadReason): string {
  if (reason === 'expired') {
    return pageHtml(
      'Invite expired',
      '<h1>This invite link has expired</h1>' +
        '<p>Ask whoever sent it for a new link, or sign in to request access.</p>' +
        '<p><a href="/">Home</a></p>',
    );
  }
  if (reason === 'used') {
    return pageHtml(
      'Invite used',
      '<h1>This invite link has already been used</h1>' +
        '<p>If you already joined, try signing in. Otherwise ask whoever sent it ' +
        'for a new link.</p>' +
        '<p><a href="/">Home</a></p>',
    );
  }
  return pageHtml(
    'Invite not valid',
    '<h1>This invite link is not valid</h1>' +
      '<p>Ask whoever sent it for a new link, or sign in to request access.</p>' +
      '<p><a href="/">Home</a></p>',
  );
}

function unavailablePage(): Response {
  return new Response(unavailablePageHtml(), {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const LEGAL_FOOTER =
  '<footer><a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>';

// Shareable collection links (`/c/...`). Unknown, revoked, expired, and a
// deleted collection all render this one page: do not say which it was.
export function collectionLinkDeadPageHtml(): string {
  return pageHtml(
    'Link not valid',
    '<h1>This link is not valid</h1>' +
      '<p>Ask the person who shared it for a new link.</p>' +
      '<p><a href="/">Home</a></p>',
  );
}

// Signed-out visitor. Names nothing about the collection: the visitor has not
// shown that they are a member yet.
export function collectionLinkSignInPageHtml(): string {
  return pageHtml(
    'Shared collection',
    '<h1>Someone shared a collection with you</h1>' +
      '<p>Sign in with Google to open it. Sous is invitation-only: this link ' +
      'works for people who already have access.</p>' +
      `<p><a class="action" href="/api/auth/start?returnTo=${encodeURIComponent('/c/join')}">` +
      'Sign in with Google</a></p>' +
      LEGAL_FOOTER,
  );
}

// Signed-in member. Joining is an explicit same-origin POST: opening a link
// never grants by itself, and the owner sees this person's email once they
// join. `linkId` is the sha256 id, not the token; it pins the POST to the
// collection this page named.
export function collectionLinkConfirmPageHtml(input: {
  linkId: string;
  collectionName: string;
  ownerEmail: string;
  role: 'viewer' | 'editor';
}): string {
  const sharer = input.ownerEmail === '' ? 'The owner' : escapeHtml(input.ownerEmail);
  const roleLine =
    input.role === 'editor'
      ? 'As an editor you can see these recipes and their photos, and edit their details but not their photos. Only the owner can delete them or change who has access.'
      : 'As a viewer you can see these recipes and their photos.';
  return pageHtml(
    'Join collection',
    `<h1>Join “${escapeHtml(input.collectionName)}”</h1>` +
      `<p>${sharer} shared this collection. ${roleLine}</p>` +
      '<p class="muted">Once you join, they will see your email address.</p>' +
      '<form method="POST" action="/c/join">' +
      `<input type="hidden" name="link" value="${escapeHtml(input.linkId)}">` +
      '<button type="submit">Join collection</button>' +
      '</form>' +
      '<p><a href="/">Not now</a></p>' +
      LEGAL_FOOTER,
  );
}

export function collectionLinkFullPageHtml(): string {
  return pageHtml(
    'Collection full',
    '<h1>This collection is full</h1>' +
      '<p>It is already shared with as many people as it can be. Ask the ' +
      'person who shared it to make room.</p>' +
      '<p><a href="/">Home</a></p>',
  );
}

export async function accessRequestPost(req: Request): Promise<Response> {
  const contentType = req.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return new Response('Unsupported Media Type', { status: 415 });
  }

  const text = await readBoundedText(req, 4096);
  if (text === null) {
    return new Response('Payload too large', { status: 413 });
  }

  const params = new URLSearchParams(text);
  const tokenPayload = verifyAccessRequestTx(params.get('t') ?? '', Date.now());
  if (tokenPayload === null) {
    return expiredPage();
  }

  try {
    const result = await recordAccessRequest(
      {
        sub: tokenPayload.sub,
        email: tokenPayload.email,
        name: tokenPayload.name,
      },
      Date.now(),
    );

    if (result.notify) {
      const stamp = new Date().toISOString();
      const nameLine = tokenPayload.name ? `Name: ${tokenPayload.name}\n` : '';
      await sendMail({
        subject: 'Sous access request',
        text:
          `Email: ${tokenPayload.email}\n` +
          nameLine +
          `Requested at (UTC): ${stamp}\n` +
          'Approve or decline at https://sous.kyrylo.lol/admin',
      });
    }

    if (result.outcome === 'already-approved') {
      return alreadyApprovedPage();
    }
    return recordedPage(result.outcome !== 'declined');
  } catch (err) {
    console.error('accessRequestPost failed:', err);
    return unavailablePage();
  }
}
