import { encodeAgentEvent } from './harness/ndjson.ts';
import { defaultAgentLimits } from './harness/limits.ts';
import { startAgent } from './harness/run.ts';
import { googleModel } from './harness/google.ts';
import {
  ASSISTANT_UNAVAILABLE_CODE,
  ASSISTANT_UNAVAILABLE_MESSAGE,
  type AgentEvent,
} from './harness/types.ts';
import { CARD_SPECS } from './sous/cards/index.ts';
import { loadAgentLibrary } from './sous/library.ts';
import { buildSystemPrompt } from './sous/prompt.ts';
import { dataTools } from './sous/tools.ts';
import {
  MAX_AGENT_BODY_BYTES,
  parseAgentRequest,
  replayCards,
} from './request.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
  storeUnavailable,
} from '../membership.ts';
import { readKitchenProfileBlock } from '../kitchenProfile.ts';

const LIBRARY_LOAD_TIMEOUT_MS = 90_000;
const AGENT_WALL_MS = 90_000;

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export async function agentPost(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  const rawBody = await readBoundedText(req, MAX_AGENT_BODY_BYTES);
  if (rawBody === null) {
    return jsonError('Request too large', 413);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return jsonError('Bad request', 400);
  }

  const parsed = parseAgentRequest(parsedJson);
  if (!parsed.ok) {
    return jsonError('Bad request', 400);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    return jsonError('Assistant is unavailable.', 503);
  }

  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const loadPromise = loadAgentLibrary(access.sub, {
    maxDocs: 2000,
    maxBytes: 8_000_000,
    maxIndexEntries: 500,
    maxIndexChars: 40_000,
  });
  void loadPromise.catch(() => {});
  // Read beside the library; a failed read is 503, never an answer that
  // ignores the member's allergies.
  const profilePromise = readKitchenProfileBlock(access.sub);
  void profilePromise.catch(() => {});
  let library;
  let kitchenProfile: string;
  try {
    [library, kitchenProfile] = await Promise.race([
      Promise.all([loadPromise, profilePromise]),
      new Promise<never>((_, reject) => {
        loadTimer = setTimeout(() => reject(new Error('library load timeout')), LIBRARY_LOAD_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return storeUnavailable();
  } finally {
    if (loadTimer !== undefined) {
      clearTimeout(loadTimer);
    }
  }

  const messages = replayCards(parsed.value.messages, library);
  const modelName = process.env.CHAT_MODEL || 'gemini-3.7-flash';
  const stop = new AbortController();
  const deadline = AbortSignal.timeout(AGENT_WALL_MS);
  const signal = AbortSignal.any([deadline, stop.signal]);

  const runStarted = Date.now();
  let agentRun;
  try {
    agentRun = await startAgent({
      model: googleModel({ apiKey, model: modelName }),
      systemInstruction: buildSystemPrompt({
        library,
        clientNow: parsed.value.clientNow,
        timeZone: parsed.value.timeZone,
        cards: CARD_SPECS,
        kitchenProfile,
      }),
      messages,
      tools: dataTools(library),
      cards: CARD_SPECS,
      ctx: library,
      limits: defaultAgentLimits(),
      signal,
    });
  } catch {
    return jsonError('Assistant is unavailable.', 502);
  }

  const encoder = new TextEncoder();
  let streamSettled = false;
  const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array) => {
    if (streamSettled) {
      return;
    }
    try {
      controller.enqueue(bytes);
    } catch {
      streamSettled = true;
    }
  };
  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (streamSettled) {
      return;
    }
    streamSettled = true;
    try {
      controller.close();
    } catch {
      /* consumer already cancelled */
    }
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let doneEmitted = false;
        void agentRun
          .run((event: AgentEvent) => {
            if (event.t === 'done') {
              doneEmitted = true;
            }
            if (event.t === 'tool' && event.phase === 'end') {
              console.log(`agent tool ${event.name} ok=${event.ok === true}`);
            }
            safeEnqueue(controller, encoder.encode(encodeAgentEvent(event)));
          })
          .then((summary) => {
            console.log(
              `agent steps=${summary.steps} calls=${summary.calls} resultBytes=${summary.resultBytes} finish=${summary.finish} recipes=${library.recipes.length} collections=${library.collections.length} truncated=${library.truncated} durationMs=${Date.now() - runStarted}`,
            );
            safeClose(controller);
          })
          .catch(() => {
            if (!doneEmitted) {
              safeEnqueue(
                controller,
                encoder.encode(
                  encodeAgentEvent({
                    t: 'error',
                    code: ASSISTANT_UNAVAILABLE_CODE,
                    message: ASSISTANT_UNAVAILABLE_MESSAGE,
                  }),
                ),
              );
              safeEnqueue(controller, encoder.encode(encodeAgentEvent({ t: 'done' })));
            }
            console.log(
              `agent steps=0 calls=0 resultBytes=0 finish=error recipes=${library.recipes.length} collections=${library.collections.length} truncated=${library.truncated} durationMs=${Date.now() - runStarted}`,
            );
            safeClose(controller);
          })
          .catch(() => {
            /* Stop can close the stream before enqueue or close runs. */
          });
      },
      cancel() {
        streamSettled = true;
        stop.abort();
      },
    }),
    {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}
