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

/** The PostgreSQL schemes libpq and `pg` both accept for the same thing. */
const POSTGRES_SCHEMES = new Set(['postgres:', 'postgresql:']);
const DEFAULT_POSTGRES_PORT = '5432';

/**
 * Canonical identity of a PostgreSQL database: host, port, database name.
 *
 * Two URLs that address the same database must produce the same string, or the
 * shared-database guard can be walked past without meaning to. The case that
 * actually got through: `localhost/db` and `localhost:5432/db` differ only in
 * whether the DEFAULT port is written down, and the previous comparison used
 * `url.host` — which includes the port only when it is explicit. Same database,
 * two identities, guard satisfied, audit free to wipe it.
 *
 * Canonicalised here:
 *
 *   * `postgres:` and `postgresql:` — the same scheme under two names;
 *   * hostname case, which `URL` already lowercases, and a trailing root dot;
 *   * an omitted port, which for PostgreSQL means 5432;
 *   * a trailing slash and any query string, neither of which selects a
 *     different database;
 *   * percent-encoding in the database name.
 *
 * Credentials are excluded entirely: the same database reached as two different
 * users is still the same database.
 *
 * NOT canonicalised, deliberately: host ALIASES. `localhost` and `127.0.0.1`
 * usually reach the same server, but proving it needs name resolution against
 * the environment the audit will actually run in, and a guard that guesses is
 * worse than one whose limit is written down. Two aliases for one host will
 * still be treated as different databases.
 */
export function databaseIdentity(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AuditDatabaseError('is not a valid PostgreSQL connection URL');
  }
  if (!POSTGRES_SCHEMES.has(parsed.protocol)) {
    throw new AuditDatabaseError(
      `must use postgres: or postgresql:, not ${parsed.protocol.replace(':', '')}:`,
    );
  }
  let host = parsed.hostname.toLowerCase();
  // A single trailing dot is the DNS root and addresses the same host.
  if (host.length > 1 && host.endsWith('.')) host = host.slice(0, -1);
  const port = parsed.port === '' ? DEFAULT_POSTGRES_PORT : parsed.port;

  const raw = parsed.pathname.replace(/^\//, '').replace(/\/$/, '');
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  if (name === '') throw new AuditDatabaseError('names no database');
  return `${host}:${port}/${name}`;
}

/**
 * Identity for a URL we are only COMPARING against. A malformed one cannot be
 * canonicalised, and refusing to run because some unrelated variable is
 * malformed would be unhelpful — but silently skipping the comparison would be
 * unsafe, so it falls back to a trimmed literal match.
 */
function comparableIdentity(url: string): string {
  try {
    return databaseIdentity(url);
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
  // Canonicalised FIRST: a malformed URL, a non-PostgreSQL scheme or a missing
  // database name is refused here, before any comparison and long before any
  // wipe.
  let auditIdentity: string;
  try {
    auditIdentity = databaseIdentity(audit);
  } catch (error) {
    throw new AuditDatabaseError(`${AUDIT_DATABASE_VAR} ${(error as Error).message}`);
  }

  for (const other of ['DATABASE_URL', 'TEST_DATABASE_URL'] as const) {
    const value = env[other]?.trim();
    if (value && comparableIdentity(value) === auditIdentity) {
      throw new AuditDatabaseError(
        `${AUDIT_DATABASE_VAR} points at the same database as ${other} ` +
          `(${databaseNameOf(audit)}). Give the audit its own database.`,
      );
    }
  }
  return audit;
}

export interface WeekdayBranchRow {
  date: string;
  weekday: string;
  byBranch: Record<string, number>;
}

export interface WeekdayBranchStability {
  failures: string[];
  canonicalByWeekday: Record<string, Record<string, number>>;
}

/** Key-sorted, so two maps built in different orders compare equal. */
export function canonicaliseBranchMap(map: Record<string, number>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * Every occurrence of a weekday must produce the SAME branch distribution.
 *
 * Extracted from the audit script so it can be falsified directly. The script
 * already recorded a map per date and checked its sum; that every Monday agreed
 * with every other Monday was computed by hand from the JSON afterwards, so a
 * disagreement would have exited zero and been reported as a pass. A property
 * believed rather than checked is the same shape as the defect this branch
 * exists to remove.
 *
 * `alwaysNamed` weekdays are called out individually rather than folded into
 * the loop, because the seed rules single them out and a regression in either
 * should be unmissable.
 */
export function checkWeekdayBranchStability(
  rows: readonly WeekdayBranchRow[],
  alwaysNamed: readonly string[] = ['Friday', 'Saturday'],
): WeekdayBranchStability {
  const byWeekday = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const variants = byWeekday.get(row.weekday) ?? new Map<string, string[]>();
    const key = canonicaliseBranchMap(row.byBranch);
    variants.set(key, [...(variants.get(key) ?? []), row.date]);
    byWeekday.set(row.weekday, variants);
  }

  const failures: string[] = [];
  const canonicalByWeekday: Record<string, Record<string, number>> = {};
  for (const [weekday, variants] of byWeekday) {
    if (variants.size === 1) {
      canonicalByWeekday[weekday] = JSON.parse([...variants.keys()][0]!) as Record<string, number>;
      continue;
    }
    failures.push(
      `${weekday} produced ${variants.size} different byBranch maps: ` +
        [...variants.entries()].map(([map, dates]) => `${map} on ${dates.join(',')}`).join(' | '),
    );
  }
  for (const weekday of alwaysNamed) {
    const variants = byWeekday.get(weekday);
    if (variants !== undefined && variants.size !== 1) {
      failures.push(`${weekday} maps disagree across its occurrences`);
    }
  }
  return { failures, canonicalByWeekday };
}
