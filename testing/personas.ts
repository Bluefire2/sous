/**
 * Test-mode personas (docs/plans/test-mode.md). Each is a fake account the
 * test server can sign in with a real session cookie. `sub`s start with
 * `test-` (Google's are numeric) and emails use the reserved `.invalid`
 * domain, so no persona can ever be a real person.
 */

export type Admission = 'owner' | 'member' | 'pending' | 'declined';

export interface Persona {
  /** The `as=` value on `/__test/sign-in`. */
  as: string;
  sub: string;
  email: string;
  name: string;
  admission: Admission;
  /** One line for the `/__test/` picker. */
  description: string;
}

export const PERSONAS = [
  {
    as: 'owner',
    sub: 'test-owner',
    email: 'owner@sous.invalid',
    name: 'Olena Owner',
    admission: 'owner',
    description: 'Owner (ALLOWED_EMAILS): /admin, 2 recipes, a collection shared with viewer as editor',
  },
  {
    as: 'member',
    sub: 'test-member',
    email: 'member@sous.invalid',
    name: 'Max Member',
    admission: 'member',
    description: 'Member with a full library: 7 recipes (one a variant), 2 collections, cook log, chat, a connected app',
  },
  {
    as: 'empty',
    sub: 'test-empty',
    email: 'empty@sous.invalid',
    name: 'Emma Empty',
    admission: 'member',
    description: 'Member with nothing: no recipes, no collections, no shares',
  },
  {
    as: 'viewer',
    sub: 'test-viewer',
    email: 'viewer@sous.invalid',
    name: 'Vic Viewer',
    admission: 'member',
    description: "Member with 1 recipe, viewer of member's Weeknights, editor of owner's picks",
  },
  {
    as: 'outsider',
    sub: 'test-outsider',
    email: 'outsider@sous.invalid',
    name: 'Oscar Outsider',
    admission: 'pending',
    description: 'Signed in but not admitted; has a pending access request',
  },
  {
    as: 'declined',
    sub: 'test-declined',
    email: 'declined@sous.invalid',
    name: 'Dana Declined',
    admission: 'declined',
    description: 'Signed in but not admitted; access request declined',
  },
] as const satisfies readonly Persona[];

export type PersonaName = (typeof PERSONAS)[number]['as'];

export function personaByName(name: string | null): Persona | undefined {
  return PERSONAS.find((persona) => persona.as === name);
}

export function persona(name: PersonaName): Persona {
  const found = personaByName(name);
  if (found === undefined) {
    throw new Error(`Unknown persona ${name}`);
  }
  return found;
}

export const OWNER_EMAIL = persona('owner').email;
