import { describe, expect, it } from 'vitest';
import { firestoreTarget } from './env.ts';

describe('firestoreTarget', () => {
  it('names the project and the named database', () => {
    expect(firestoreTarget({ GOOGLE_CLOUD_PROJECT: 'p', FIRESTORE_DATABASE_ID: 'sous-us' })).toBe('p/sous-us');
  });

  it('says (default) when no database is named, blank included', () => {
    expect(firestoreTarget({ GOOGLE_CLOUD_PROJECT: 'p' })).toBe('p/(default)');
    expect(firestoreTarget({ GOOGLE_CLOUD_PROJECT: 'p', FIRESTORE_DATABASE_ID: '  ' })).toBe('p/(default)');
  });

  it('puts the emulator first when one is set', () => {
    expect(
      firestoreTarget({ GOOGLE_CLOUD_PROJECT: 'p', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085' }),
    ).toBe('emulator 127.0.0.1:8085, p/(default)');
  });

  it('does not throw without a project, so a script can print before failing', () => {
    expect(firestoreTarget({})).toBe('(no GOOGLE_CLOUD_PROJECT)/(default)');
  });
});
