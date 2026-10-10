import type { ImportFeedbackReport, ImportRatingUp } from '../../server/importFeedbackShape.ts';
import { t } from '../i18n';
import { invalidateSession } from './session';

/** Send a report or a thumbs-up. The server answers 204 with no body. */
export async function sendImportFeedback(body: ImportFeedbackReport | ImportRatingUp): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/import-feedback', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(t('importFeedback.sendFailed'));
  }
  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  if (!response.ok) throw new Error(t('importFeedback.sendFailed'));
}
