/**
 * The commit this server was built from. `scripts/write-build-info.sh` writes
 * server/build-info.json just before a deploy builds the image; a local run
 * or the CI image has none, and reports nulls. GET /api/version serves it.
 */
import { readFileSync } from 'node:fs';

export interface BuildInfo {
  commit: string | null;
  builtAt: string | null;
}

const UNKNOWN: BuildInfo = { commit: null, builtAt: null };

/** A missing, unreadable, or malformed file is unknown, never a startup failure. */
export function parseBuildInfo(text: string | null): BuildInfo {
  if (text === null) return UNKNOWN;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return UNKNOWN;
    const { commit, builtAt } = value as Record<string, unknown>;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}(-dirty)?$/.test(commit)) return UNKNOWN;
    if (typeof builtAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(builtAt)) return UNKNOWN;
    return { commit, builtAt };
  } catch {
    return UNKNOWN;
  }
}

function readBuildInfoFile(): string | null {
  try {
    return readFileSync(new URL('./build-info.json', import.meta.url), 'utf8');
  } catch {
    return null;
  }
}

export const buildInfo: BuildInfo = parseBuildInfo(readBuildInfoFile());
