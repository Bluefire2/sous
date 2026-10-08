import { t, type MessageKey, type TranslateParams } from '../i18n';

/**
 * Machine codes from import, extension import, stt, admin, sharing,
 * translation, and the daily AI budget (every model route). The same English
 * sentence shares one code across those routes.
 */
const ERROR_CODES = {
  'import-bad-url': 'error.importBadUrl',
  'import-bad-scheme': 'error.importBadScheme',
  'import-unreachable': 'error.importUnreachable',
  'import-refused': 'error.importRefused',
  'import-empty': 'error.importEmpty',
  'import-no-recipe': 'error.importNoRecipe',
  'import-extract-failed': 'error.importExtractFailed',
  'import-unusable': 'error.importUnusable',
  'import-model-failed': 'error.importModelFailed',
  'import-too-many-photos': 'error.importTooManyPhotos',
  'import-bad-photo-type': 'error.importBadPhotoType',
  'import-photos-unreadable': 'error.importPhotosUnreadable',
  'import-photos-too-large': 'error.importPhotosTooLarge',
  'import-body-too-large': 'error.importBodyTooLarge',
  'import-photos-failed': 'error.importPhotosFailed',
  'import-no-recipe-photos': 'error.importNoRecipePhotos',
  'import-brief-too-long': 'error.importBriefTooLong',
  'import-search-rate-limited': 'error.importSearchRateLimited',
  'import-no-recipe-brief': 'error.importNoRecipeBrief',
  'import-generate-failed': 'error.importGenerateFailed',
  'import-bad-language': 'error.sttBadLanguage',
  'bad-request': 'error.badRequest',
  'stt-bad-request': 'error.badRequest',
  'stt-unavailable': 'error.sttUnavailable',
  'stt-too-long': 'error.sttTooLong',
  'stt-bad-language': 'error.sttBadLanguage',
  'stt-failed': 'error.dictationFailed',
  'not-found': 'error.notFound',
  'share-self': 'error.shareSelf',
  'share-no-account': 'error.shareNoAccount',
  'share-full': 'error.shareFull',
  'link-cap': 'error.linkCap',
  self: 'error.adminSelf',
  'unknown-request': 'error.adminUnknownRequest',
  'unknown-invite': 'error.adminUnknownInvite',
  'invite-cap': 'error.inviteCap',
  'member-invite-cap': 'error.memberInviteCap',
  'member-invite-limit': 'error.memberInviteLimit',
  'unsupported-media': 'error.unsupportedMedia',
  'payload-too-large': 'error.payloadTooLarge',
  'translate-bad-request': 'error.translateBadRequest',
  'translate-too-large': 'error.translateTooLarge',
  'translate-unavailable': 'error.translateUnavailable',
  'translate-provider-unavailable': 'error.translateProviderUnavailable',
  'translate-failed': 'error.translateFailed',
  'translate-rate-limited': 'error.translateRateLimited',
  'llm-budget-exceeded': 'error.llmBudgetExceeded',
  'llm-busy': 'error.llmBusy',
} as const satisfies Record<string, MessageKey>;

type ErrorCode = keyof typeof ERROR_CODES;

/** Used only when an invite-cap body omits `max`. Sharing reads `max` from the body. */
const INVITE_CAP_MAX_FALLBACK = 20;
/** Keep in sync with `MEMBER_INVITE_LIMIT` in `server/invites.ts`. */
const MEMBER_INVITE_LIMIT_FALLBACK = 5;

function asRecord(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function numericField(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

/**
 * `null` means a required placeholder is missing, so the caller should not
 * use the catalog string (it would show `{max}` or `{status}` literally).
 */
function paramsFor(code: ErrorCode, body: Record<string, unknown>): TranslateParams | undefined | null {
  if (code === 'share-full') {
    const max = numericField(body, 'max');
    return max === undefined ? null : { max };
  }
  if (code === 'link-cap') {
    // A plural message: `count` selects the form.
    const max = numericField(body, 'max');
    return max === undefined ? null : { count: max };
  }
  if (code === 'invite-cap' || code === 'member-invite-limit') {
    const fallback = code === 'invite-cap' ? INVITE_CAP_MAX_FALLBACK : MEMBER_INVITE_LIMIT_FALLBACK;
    return { max: numericField(body, 'max') ?? fallback };
  }
  if (code === 'import-refused') {
    const status = numericField(body, 'status');
    return status === undefined ? null : { status };
  }
  return undefined;
}

/**
 * Catalog text for a known `code`. An unknown or absent code uses the English
 * `error` string. If that is missing too, `fallbackKey` is the generic line.
 */
export function serverErrorText(
  body: unknown,
  fallbackKey: MessageKey,
  fallbackParams?: TranslateParams,
): string {
  const record = asRecord(body);
  const code = record !== null && typeof record.code === 'string' ? record.code : undefined;
  const english =
    record !== null && typeof record.error === 'string' && record.error !== ''
      ? record.error
      : undefined;
  if (code !== undefined && isErrorCode(code)) {
    const params = paramsFor(code, record ?? {});
    if (params !== null) {
      return t(ERROR_CODES[code], params);
    }
  }
  if (english !== undefined) {
    return english;
  }
  return t(fallbackKey, fallbackParams);
}

/** Same text as `serverErrorText`, with `code` copied onto the Error when the body has one. */
export function serverError(
  body: unknown,
  fallbackKey: MessageKey,
  fallbackParams?: TranslateParams,
): Error {
  const err = new Error(serverErrorText(body, fallbackKey, fallbackParams));
  const record = asRecord(body);
  if (record !== null && typeof record.code === 'string' && record.code !== '') {
    return Object.assign(err, { code: record.code });
  }
  return err;
}
