import { describe, expect, it } from 'vitest';
import { isLibrarySearchShortcut, type ShortcutKeyEvent } from './librarySearchShortcut';

const body = { tagName: 'BODY', isContentEditable: false } as unknown as EventTarget;

const key = (overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: '/',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  defaultPrevented: false,
  target: body,
  ...overrides,
});

const element = (tagName: string, isContentEditable = false) =>
  ({ tagName, isContentEditable }) as unknown as EventTarget;

describe('isLibrarySearchShortcut', () => {
  it('takes a bare / on the page, or on a button or link', () => {
    expect(isLibrarySearchShortcut(key(), false)).toBe(true);
    expect(isLibrarySearchShortcut(key({ target: element('BUTTON') }), false)).toBe(true);
    expect(isLibrarySearchShortcut(key({ target: element('A') }), false)).toBe(true);
    expect(isLibrarySearchShortcut(key({ target: null }), false)).toBe(true);
  });

  it('ignores other keys', () => {
    expect(isLibrarySearchShortcut(key({ key: '?' }), false)).toBe(false);
    expect(isLibrarySearchShortcut(key({ key: 'Escape' }), false)).toBe(false);
  });

  it('ignores / with Ctrl, Alt or Meta', () => {
    expect(isLibrarySearchShortcut(key({ ctrlKey: true }), false)).toBe(false);
    expect(isLibrarySearchShortcut(key({ altKey: true }), false)).toBe(false);
    expect(isLibrarySearchShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it('leaves / typed into a field alone, the search box included', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      expect(isLibrarySearchShortcut(key({ target: element(tag) }), false)).toBe(false);
    }
    expect(isLibrarySearchShortcut(key({ target: element('DIV', true) }), false)).toBe(false);
  });

  it('does nothing while a sheet or menu is open', () => {
    expect(isLibrarySearchShortcut(key(), true)).toBe(false);
  });

  it('does nothing during composition or after another handler took the key', () => {
    expect(isLibrarySearchShortcut(key({ isComposing: true }), false)).toBe(false);
    expect(isLibrarySearchShortcut(key({ defaultPrevented: true }), false)).toBe(false);
  });
});
