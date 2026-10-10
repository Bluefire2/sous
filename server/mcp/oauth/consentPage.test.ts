import { describe, expect, it } from 'vitest';
import { consentErrorPageHtml, consentPageHtml } from './consentPage.ts';

const BASE = {
  clientHost: 'claude.ai',
  scopes: ['recipes:read'] as const,
  redirectHost: 'claude.ai',
  loopback: false,
  email: 'member@example.com',
  nonce: 'n1',
};

describe('consentPageHtml', () => {
  it('escapes a hostile client_name and every other value', () => {
    const html = consentPageHtml({
      ...BASE,
      clientName: '<script>alert(1)</script>',
      email: '"><img src=x>@example.com',
      nonce: '"><b>',
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('value="&quot;&gt;&lt;b&gt;"');
  });

  it('names the client host as the app and quotes the self-asserted name', () => {
    const html = consentPageHtml({ ...BASE, clientName: 'Claude' });
    expect(html).toContain('<h1>claude.ai wants to use your Sous recipes</h1>');
    expect(html).toContain('It calls itself “Claude”. That name comes from the app and is not checked.');
    expect(html).toContain('Signed in as member@example.com.');
    expect(html).toContain('Settings → Connected apps');
  });

  it('shows the edit ability only when write is asked for', () => {
    expect(consentPageHtml(BASE)).not.toContain('edit the recipes');
    expect(consentPageHtml({ ...BASE, scopes: ['recipes:read', 'recipes:write'] })).toContain(
      'Add new recipes, edit the recipes in your own library, and move them between your collections. Moving a recipe into a collection you share with other members shows it to them; it never adds recipes to a collection that has a public link.',
    );
  });

  it('warns about a loopback redirect', () => {
    expect(consentPageHtml(BASE)).not.toContain('runs on your computer');
    expect(consentPageHtml({ ...BASE, loopback: true, redirectHost: 'localhost:3118' })).toContain(
      'This app runs on your computer. Only allow it if you just started connecting it.',
    );
  });

  it('posts the nonce and the decision to /oauth/consent', () => {
    const html = consentPageHtml(BASE);
    expect(html).toContain('<form method="POST" action="/oauth/consent">');
    expect(html).toContain('name="decision" value="allow"');
    expect(html).toContain('name="decision" value="deny"');
  });
});

describe('consentErrorPageHtml', () => {
  it('links home and never names a redirect target', () => {
    const html = consentErrorPageHtml('redirect_mismatch');
    expect(html).toContain('<h1>Can’t connect this app</h1>');
    expect(html).toContain('href="/"');
  });
});
