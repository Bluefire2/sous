/**
 * Test double for `RecipeImportDeps`. Returns a real `GenerateContentResponse`
 * so `.text` is the SDK's own getter, not a hand-written stand-in.
 *
 * Lives outside `server/` because the Dockerfile copies `server/` into the
 * runtime image and `server/membership.test.ts` scans every non-test file
 * there as production code.
 */
import {
  GenerateContentResponse,
  type GenerateContentParameters,
  type GroundingMetadata,
} from '@google/genai';
import type { RecipeImportDeps } from '../server/recipeImport.ts';
import { TRANSLATE_FAILED, type TranslateOutcome } from '../server/translate.ts';

export function fakeImportDeps(
  reply: string | undefined,
  translator?: RecipeImportDeps['translator'],
  options: {
    /** Attached to the candidate, as Google Search grounding reports it. */
    groundingMetadata?: GroundingMetadata;
  } = {},
): {
  deps: RecipeImportDeps;
  calls: GenerateContentParameters[];
} {
  const calls: GenerateContentParameters[] = [];
  const deps: RecipeImportDeps = {
    model: 'test-model',
    ai: {
      models: {
        generateContent: (params) => {
          calls.push(params);
          const response = new GenerateContentResponse();
          if (reply !== undefined) {
            response.candidates = [
              {
                content: { role: 'model', parts: [{ text: reply }] },
                ...(options.groundingMetadata !== undefined
                  ? { groundingMetadata: options.groundingMetadata }
                  : {}),
              },
            ];
          }
          return Promise.resolve(response);
        },
      },
    },
    translator:
      translator ??
      ((): Promise<TranslateOutcome> =>
        Promise.resolve({ ok: false, code: TRANSLATE_FAILED })),
  };
  return { deps, calls };
}
