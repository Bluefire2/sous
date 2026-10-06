/**
 * Adds the link-token exclusion (`scripts/logExclusions.ts`) to the `_Default`
 * log sink of the production project, keeping every other exclusion and the
 * sink's destination and filter. Dry run unless `--apply`:
 *
 *   node scripts/apply-log-exclusions.ts [--apply]
 *
 * Uses ADC (`gcloud auth application-default login`); the account needs
 * permission to update sinks (`roles/logging.configWriter` or owner). This
 * changes production logging; run `--apply` only with the owner's approval,
 * and before deploying the `/privacy` text that relies on it.
 *
 * `runApplyLogExclusions` is the whole program with the API client passed in,
 * so `scripts/apply-log-exclusions.test.ts` can run it against a fake sink.
 * The ADC client is created only when the file is run directly.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import {
  LINK_TOKEN_EXCLUSION,
  exclusionsApplied,
  planExclusions,
  type LogExclusion,
} from './logExclusions.ts';

const PROJECT = 'cooking-assistant-508423';
export const SINK_URL = `https://logging.googleapis.com/v2/projects/${PROJECT}/sinks/_Default`;

export interface Sink {
  name: string;
  destination: string;
  filter?: string;
  disabled?: boolean;
  exclusions?: LogExclusion[];
}

/** The slice of the google-auth-library client this script uses. */
export interface SinkClient {
  request<T>(options: { url: string; method?: string; data?: unknown }): Promise<{ data: T }>;
}

function describeSink(sink: Sink): string {
  const names = (sink.exclusions ?? []).map(
    (exclusion) => `${exclusion.name}${exclusion.disabled === true ? ' (disabled)' : ''}`,
  );
  return `_Default -> ${sink.destination}; exclusions: ${names.length === 0 ? '(none)' : names.join(', ')}`;
}

/** The program. `argv` is the arguments after the script path. Returns the exit code. */
export async function runApplyLogExclusions(
  argv: readonly string[],
  client: SinkClient,
  output: { log: (line: string) => void; error: (line: string) => void } = console,
): Promise<number> {
  const apply = argv.includes('--apply');
  const readSink = async (): Promise<Sink> => (await client.request<Sink>({ url: SINK_URL })).data;

  const before = await readSink();
  output.log(`Before: ${describeSink(before)}`);

  const plan = planExclusions(before.exclusions ?? []);
  if (plan.kind === 'in_place') {
    output.log(`${LINK_TOKEN_EXCLUSION.name} is already in place. Nothing to do.`);
    return 0;
  }

  output.log(`Plan: ${plan.kind} ${LINK_TOKEN_EXCLUSION.name}`);
  output.log(`  filter: ${LINK_TOKEN_EXCLUSION.filter}`);
  if (!apply) {
    output.log('Dry run; pass --apply to write.');
    return 0;
  }

  await client.request({
    url: `${SINK_URL}?updateMask=exclusions`,
    method: 'PATCH',
    data: { exclusions: plan.next },
  });

  const after = await readSink();
  output.log(`After:  ${describeSink(after)}`);
  const sinkUnchanged =
    after.destination === before.destination &&
    (after.filter ?? '') === (before.filter ?? '') &&
    (after.disabled === true) === (before.disabled === true);
  if (!sinkUnchanged || !exclusionsApplied(before.exclusions ?? [], after.exclusions ?? [])) {
    output.error('The sink does not have the expected shape after the update. Check it by hand.');
    return 1;
  }
  output.log('Verified: the exclusion is present and enabled, and the sink is otherwise unchanged.');
  return 0;
}

/** Real paths on both sides, as in scripts/delete-account-data.ts: a symlinked run must not silently do nothing. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const client = await new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    projectId: PROJECT,
  }).getClient();
  process.exit(await runApplyLogExclusions(process.argv.slice(2), client as unknown as SinkClient));
}
