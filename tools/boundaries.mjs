/**
 * Modular-monolith boundary rules, enforced two ways:
 *  - eslint no-restricted-imports (editor/CI feedback per file)
 *  - tools/boundaries.test.ts (a test that fails when any rule is broken)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ZONES = [
  {
    name: 'frontends must not import the database or server-only modules',
    dirs: ['apps/branch/src', 'apps/admin/src', 'apps/customer/src'],
    forbidden: [
      /^@foot-repose\/db(\/|$)/,
      /^pg$/,
      /^bcryptjs$/,
      /^jose$/,
      /packages\/db/,
    ],
  },
  {
    name: 'domain must stay pure: no workspace, database or framework imports',
    dirs: ['packages/domain/src'],
    // Any bare (non-relative) specifier is a dependency — domain allows none.
    forbidden: [/^[^.]/],
  },
  {
    name: 'contracts may depend on domain and zod only — never the database or API internals',
    dirs: ['packages/contracts/src'],
    forbidden: [/^@foot-repose\/(db|api)(\/|$)/, /^pg$/, /packages\/db/, /apps\/api/],
  },
];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

export function importSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

export function findViolationsInSource(source, zone, file = '(inline)') {
  const violations = [];
  for (const specifier of importSpecifiers(source)) {
    if (zone.forbidden.some((rule) => rule.test(specifier))) {
      violations.push({ zone: zone.name, file, specifier });
    }
  }
  return violations;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) files.push(full);
  }
  return files;
}

export function checkBoundaries(rootDir) {
  const violations = [];
  for (const zone of ZONES) {
    for (const dir of zone.dirs) {
      for (const file of walk(join(rootDir, dir))) {
        const source = readFileSync(file, 'utf8');
        violations.push(...findViolationsInSource(source, zone, relative(rootDir, file)));
      }
    }
  }
  return violations;
}

if (process.argv[1] && process.argv[1].endsWith('boundaries.mjs')) {
  const violations = checkBoundaries(process.cwd());
  if (violations.length > 0) {
    console.error('Modular monolith boundary violations:');
    for (const violation of violations) {
      console.error(`  ${violation.file}: imports "${violation.specifier}" (${violation.zone})`);
    }
    process.exit(1);
  }
  console.log('Boundaries OK');
}
