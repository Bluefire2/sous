/**
 * Markdown helpers shared by the report and the issue. No imports, so
 * `issue.ts should-run` runs before `npm ci`.
 */

/**
 * Model and page text, safe in Markdown and in a GitHub issue: no markup,
 * no table breaks, no @mentions.
 */
export function inline(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|#~]/g, '\\$&')
    .replace(/@/g, '&#64;');
}
