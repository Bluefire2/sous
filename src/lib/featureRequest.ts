/**
 * Builds the suggestion `/suggest` sends (`docs/plans/feature-requests.md`).
 * This decides what leaves the device: the text, whether the person allowed
 * contact, and three context fields. Never the email address.
 */
import {
  featureRequestText,
  isFeatureRequestFrom,
  type FeatureRequestBody,
} from '../../server/featureRequestShape.ts';

export interface BuildFeatureRequestInput {
  id: string;
  text: string;
  contactOk: boolean;
  from?: unknown;
  locale: string;
  standalone: boolean;
}

/** Whether there is anything to send once the text is trimmed. */
export function canSendFeatureRequest(text: string): boolean {
  return featureRequestText(text) !== '';
}

/** The POST body. Absent values are omitted, never `undefined`. */
export function buildFeatureRequest(input: BuildFeatureRequestInput): FeatureRequestBody {
  const body: FeatureRequestBody = {
    id: input.id,
    text: featureRequestText(input.text),
    contactOk: input.contactOk,
  };
  if (isFeatureRequestFrom(input.from)) body.from = input.from;
  body.locale = input.locale;
  body.standalone = input.standalone;
  return body;
}
