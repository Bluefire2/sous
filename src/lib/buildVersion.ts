/** The commit the server was built from, from `GET /api/version` (`server/buildInfo.ts`). */
export interface BuildVersion {
  /** Full SHA, with `-dirty` when built from uncommitted changes. */
  commit: string;
  builtAt: number;
}

/** The build, or null for an unknown one (a local run or the CI image) or a body that is not one. */
export function parseBuildVersion(data: unknown): BuildVersion | null {
  if (typeof data !== 'object' || data === null) return null;
  const { commit, builtAt } = data as Record<string, unknown>;
  if (typeof commit !== 'string' || commit === '' || typeof builtAt !== 'string') return null;
  const at = Date.parse(builtAt);
  if (!Number.isFinite(at)) return null;
  return { commit, builtAt: at };
}

/** The first 7 characters of the SHA, keeping a `-dirty` marker. */
export function shortCommit(commit: string): string {
  const dirty = commit.endsWith('-dirty');
  const sha = dirty ? commit.slice(0, -'-dirty'.length) : commit;
  return `${sha.slice(0, 7)}${dirty ? '-dirty' : ''}`;
}

/** Null when the server does not know its build or cannot be reached; this is informational only. */
export async function fetchBuildVersion(): Promise<BuildVersion | null> {
  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) return null;
    return parseBuildVersion(await response.json());
  } catch {
    return null;
  }
}
