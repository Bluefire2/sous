import { describe, expect, it } from 'vitest';
import { feedbackUrl, stripUrlUserinfo, truncateUtf8 } from './importFeedbackShape.ts';

describe('stripUrlUserinfo', () => {
  it('removes userinfo from every http(s) link in the text', () => {
    expect(
      stripUrlUserinfo(
        '{"sourceUrl":"https://user:s3cret@recipes.example/cake?x=1","notes":"see http://bob@a.example/b"}',
      ),
    ).toBe('{"sourceUrl":"https://recipes.example/cake?x=1","notes":"see http://a.example/b"}');
  });
  it('works on text cut mid-link', () => {
    expect(stripUrlUserinfo('{"sourceUrl":"https://user:s3cret@reci')).toBe('{"sourceUrl":"https://reci');
  });
  it('leaves an @ after the host alone', () => {
    const text = 'https://example.com/path@x?q=a@b#c@d';
    expect(stripUrlUserinfo(text)).toBe(text);
  });
  it('leaves text without links alone', () => {
    expect(stripUrlUserinfo('mail me at cook@example.com')).toBe('mail me at cook@example.com');
  });
});

describe('truncateUtf8', () => {
  it('keeps short text', () => {
    expect(truncateUtf8('abc', 10)).toStrictEqual({ text: 'abc', truncated: false });
  });
  it('cuts ASCII at the byte limit', () => {
    expect(truncateUtf8('abcdef', 3)).toStrictEqual({ text: 'abc', truncated: true });
  });
  it('never splits a CJK character', () => {
    expect(truncateUtf8('汉字汉字', 7)).toStrictEqual({ text: '汉字', truncated: true });
  });
  it('never splits an emoji', () => {
    expect(truncateUtf8('😀😀', 5)).toStrictEqual({ text: '😀', truncated: true });
  });
  it('exact limit is not truncated', () => {
    expect(truncateUtf8('汉字', 6)).toStrictEqual({ text: '汉字', truncated: false });
  });
});

describe('feedbackUrl', () => {
  it('strips credentials, keeps query and fragment', () => {
    expect(feedbackUrl('https://u:p@example.com/r?id=1#x')).toBe('https://example.com/r?id=1#x');
  });
  it('trims', () => {
    expect(feedbackUrl('  https://example.com/r  ')).toBe('https://example.com/r');
  });
  it('rejects other schemes', () => {
    expect(feedbackUrl('javascript:alert(1)')).toBeUndefined();
    expect(feedbackUrl('ftp://example.com/')).toBeUndefined();
  });
  it('rejects garbage and non-strings', () => {
    expect(feedbackUrl('not a url')).toBeUndefined();
    expect(feedbackUrl(undefined)).toBeUndefined();
    expect(feedbackUrl(42)).toBeUndefined();
  });
  it('rejects over-long URLs', () => {
    expect(feedbackUrl('https://example.com/' + 'a'.repeat(2100))).toBeUndefined();
  });
});
