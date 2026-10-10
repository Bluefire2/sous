import type { FeatureRequestBody } from '../../server/featureRequestShape.ts';
import { t } from '../i18n';
import { invalidateSession } from './session';

/** Send a suggestion. The server answers 204 with no body. */
export async function sendFeatureRequest(body: FeatureRequestBody): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/feature-request', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(t('suggest.sendFailed'));
  }
  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  if (response.status === 429) throw new Error(t('suggest.rateLimited'));
  if (!response.ok) throw new Error(t('suggest.sendFailed'));
}
