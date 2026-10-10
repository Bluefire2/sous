/**
 * Server HTML for the MCP consent step. English only, like `/c/join`: a
 * server-rendered step in a flow that carries credentials, before the SPA
 * (`docs/constitutions/i18n.md` principle 9). Every interpolated value is
 * escaped. Pure.
 */
import { escapeHtml, pageHtml } from '../../access.ts';
import { SCOPE_WRITE, type McpScope } from '../config.ts';

const LEGAL_FOOTER =
  '<footer><a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>';

export type ConsentPageInput = {
  /** The host of the `client_id` URL: the app's name as far as Sous can vouch for it. */
  clientHost: string;
  /** The document's own `client_name`: quoted as the app's claim, never as fact. */
  clientName?: string;
  scopes: readonly McpScope[];
  redirectHost: string;
  loopback: boolean;
  email: string;
  /** From the hop cookie; the POST must send it back. */
  nonce: string;
};

export function consentPageHtml(input: ConsentPageInput): string {
  const host = escapeHtml(input.clientHost);
  const nameLine =
    input.clientName === undefined
      ? ''
      : `<p class="muted">It calls itself “${escapeHtml(input.clientName)}”. ` +
        'That name comes from the app and is not checked.</p>';
  const abilities = ['<li>Search and read the recipes in your own library, and list your collections.</li>'];
  if (input.scopes.includes(SCOPE_WRITE)) {
    abilities.push('<li>Add new recipes, edit the recipes in your own library, and move them between your collections. Moving a recipe into a collection you share with other members shows it to them; it never adds recipes to a collection that has a public link.</li>');
  }
  const loopback = input.loopback
    ? '<p><strong>This app runs on your computer. Only allow it if you just started connecting it.</strong></p>'
    : '';
  return pageHtml(
    'Connect an app',
    `<h1>${host} wants to use your Sous recipes</h1>` +
      nameLine +
      '<p>If you allow it, it can:</p>' +
      `<ul>${abilities.join('')}</ul>` +
      '<p class="muted">It can’t see recipes shared with you, your photos, or your cook log, ' +
      'and it can’t delete anything.</p>' +
      loopback +
      `<p>After you choose, Sous sends you back to ${escapeHtml(input.redirectHost)}.</p>` +
      `<p class="muted">Signed in as ${escapeHtml(input.email)}. Signing out of Sous doesn’t ` +
      'disconnect the app; Settings → Connected apps does.</p>' +
      '<form method="POST" action="/oauth/consent">' +
      `<input type="hidden" name="nonce" value="${escapeHtml(input.nonce)}">` +
      '<button type="submit" name="decision" value="allow">Allow</button> ' +
      '<button type="submit" name="decision" value="deny">Deny</button>' +
      '</form>' +
      LEGAL_FOOTER,
  );
}

export type ConsentErrorReason =
  | 'bad_request'
  | 'expired'
  | 'client_unverified'
  | 'redirect_mismatch'
  | 'rate_limited'
  | 'forbidden';

const ERROR_TEXT: Record<ConsentErrorReason, string> = {
  bad_request: 'The app sent a request Sous can’t use. Go back to the app and try connecting again.',
  expired: 'This connection request has expired. Go back to the app and connect again.',
  client_unverified: 'Sous couldn’t check who this app is. Go back to the app and try again later.',
  redirect_mismatch: 'The app asked Sous to send you somewhere it hasn’t registered, so Sous stopped here.',
  rate_limited: 'Too many apps are connecting right now. Try again in a minute.',
  forbidden: 'That request didn’t come from this page, so nothing was changed.',
};

/** Shown before the redirect URI is verified: never redirects anywhere. */
export function consentErrorPageHtml(reason: ConsentErrorReason): string {
  return pageHtml(
    'Can’t connect this app',
    '<h1>Can’t connect this app</h1>' +
      `<p>${escapeHtml(ERROR_TEXT[reason])}</p>` +
      '<p><a href="/">Open Sous</a></p>' +
      LEGAL_FOOTER,
  );
}
