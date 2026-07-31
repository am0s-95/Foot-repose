/**
 * The audit reseeds destructively, once per date. Which database it points at
 * is therefore a safety question, not a convenience one.
 *
 * This exists because a comment was not enough. The audit was documented as
 * needing its own database, was pointed at the one a test suite was using, and
 * the two reseeded over each other — producing a determinism failure that
 * looked exactly like a real non-determinism bug and cost a debugging cycle to
 * attribute. A rule that only lives in prose is a rule that will be broken.
 */
export class AuditDatabaseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuditDatabaseError';
  }
}

export const AUDIT_DATABASE_VAR = 'SEED_AUDIT_DATABASE_URL';

/** The database name alone — safe to print. Credentials never are. */
export function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || '(none)';
  } catch {
    return '(unparseable)';
  }
}

/** Normalised for comparison, so `...?sslmode=x` or a trailing slash cannot
 * disguise the same database as a different one. */
function fingerprint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * The database the audit may wipe, or a thrown `AuditDatabaseError`.
 *
 * Checked BEFORE anything is written, so a misconfigured run destroys nothing.
 */
export function resolveAuditDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const audit = env[AUDIT_DATABASE_VAR]?.trim();
  if (!audit) {
    throw new AuditDatabaseError(
      `${AUDIT_DATABASE_VAR} is not set. The audit wipes and reseeds once per date, so it ` +
        'needs a database of its own — sharing one with a running suite corrupts both.',
    );
  }
  const auditPrint = fingerprint(audit);
  for (const other of ['DATABASE_URL', 'TEST_DATABASE_URL'] as const) {
    const value = env[other]?.trim();
    if (value && fingerprint(value) === auditPrint) {
      throw new AuditDatabaseError(
        `${AUDIT_DATABASE_VAR} points at the same database as ${other} ` +
          `(${databaseNameOf(audit)}). Give the audit its own database.`,
      );
    }
  }
  return audit;
}
