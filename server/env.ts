function envError(name: string): Error {
  return new Error(
    `${name} is not set. Set ${name} in \`.env.local\` for dev, or via \`scripts/deploy.sh\` on Cloud Run.`,
  );
}

export function publicOrigin(): string {
  const raw = process.env.PUBLIC_ORIGIN;
  if (raw === undefined || raw.trim() === '') {
    throw envError('PUBLIC_ORIGIN');
  }
  return raw.trim().replace(/\/+$/, '');
}

export function redirectUri(): string {
  return `${publicOrigin()}/api/auth/callback/google`;
}

export function googleClient(): { id: string; secret: string } {
  const id = process.env.AUTH_GOOGLE_ID?.trim();
  if (!id) {
    throw envError('AUTH_GOOGLE_ID');
  }
  const secret = process.env.AUTH_GOOGLE_SECRET?.trim();
  if (!secret) {
    throw envError('AUTH_GOOGLE_SECRET');
  }
  return { id, secret };
}

export function sessionSecret(): string | null {
  const raw = process.env.SESSION_SECRET;
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  return raw;
}

export function allowedEmails(): string {
  const raw = process.env.ALLOWED_EMAILS;
  if (raw === undefined) {
    return '';
  }
  return raw;
}

export function firestoreConfig(): { projectId: string; databaseId?: string } {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!projectId) {
    throw envError('GOOGLE_CLOUD_PROJECT');
  }
  const databaseId = process.env.FIRESTORE_DATABASE_ID?.trim();
  if (databaseId) {
    return { projectId, databaseId };
  }
  return { projectId };
}

/**
 * Where Firestore calls go, for a script to print before it reads or writes:
 * an unset FIRESTORE_DATABASE_ID quietly means `(default)`, which is not the
 * production database (`docs/plans/us-region-move.md`).
 */
export function firestoreTarget(env: NodeJS.ProcessEnv = process.env): string {
  const emulator = env.FIRESTORE_EMULATOR_HOST?.trim();
  const projectId = env.GOOGLE_CLOUD_PROJECT?.trim() || '(no GOOGLE_CLOUD_PROJECT)';
  const databaseId = env.FIRESTORE_DATABASE_ID?.trim() || '(default)';
  const where = `${projectId}/${databaseId}`;
  return emulator ? `emulator ${emulator}, ${where}` : where;
}

export function photoBucket(): string | null {
  const raw = process.env.PHOTO_BUCKET?.trim();
  if (!raw) {
    return null;
  }
  return raw;
}

export function isSecureOrigin(): boolean {
  return new URL(publicOrigin()).protocol === 'https:';
}

export function resendApiKey(): string | null {
  const raw = process.env.RESEND_API_KEY;
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  return raw.trim();
}

export function mailFrom(): string {
  const raw = process.env.MAIL_FROM;
  if (raw === undefined || raw.trim() === '') {
    throw envError('MAIL_FROM');
  }
  return raw.trim();
}

export function ownerNotifyEmail(): string {
  const raw = process.env.OWNER_NOTIFY_EMAIL;
  if (raw === undefined || raw.trim() === '') {
    throw envError('OWNER_NOTIFY_EMAIL');
  }
  return raw.trim();
}
