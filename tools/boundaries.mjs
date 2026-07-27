/**
 * Modular-monolith boundary rules, enforced two ways:
 *  - eslint no-restricted-imports (editor/CI feedback per file, bare specifiers)
 *  - tools/boundaries.test.ts (fails the suite when any rule is broken)
 *
 * The scanner is path-aware: relative imports are resolved against the
 * importing file, so `../../../apps/api/...` escapes are caught, and the
 * domain package manifest is checked so domain cannot silently gain a
 * dependency.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

export const ZONES = [
  {
    name: 'frontends must not import the database or server-only modules',
    dirs: ['apps/branch/src', 'apps/admin/src', 'apps/customer/src'],
    forbiddenBare: [/^@foot-repose\/db(\/|$)/, /^pg$/, /^bcryptjs$/, /^jose$/],
    forbiddenResolvedPrefixes: ['apps/api/', 'packages/db/'],
  },
  {
    name: 'domain must stay pure: no dependencies, and no reaching outside its package',
    dirs: ['packages/domain/src'],
    // Any bare (non-relative) specifier is a dependency — domain allows none.
    forbiddenBare: [/^[^.]/],
    mustStayWithin: ['packages/domain/'],
  },
  {
    name: 'contracts may depend on domain and zod only — never the database or API internals',
    dirs: ['packages/contracts/src'],
    forbiddenBare: [/^@foot-repose\/(db|api)(\/|$)/, /^pg$/],
    forbiddenResolvedPrefixes: ['packages/db/', 'apps/'],
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

/** Resolve a relative specifier to a repo-relative posix path. */
export function resolveRelativeImport(repoRelativeFile, specifier) {
  return posix.normalize(posix.join(posix.dirname(repoRelativeFile), specifier));
}

export function findViolationsInFile(source, zone, repoRelativeFile) {
  const violations = [];
  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith('.')) {
      const resolved = resolveRelativeImport(repoRelativeFile, specifier);
      const escapes =
        zone.mustStayWithin && !zone.mustStayWithin.some((p) => resolved.startsWith(p));
      const forbidden = (zone.forbiddenResolvedPrefixes ?? []).some((p) =>
        resolved.startsWith(p),
      );
      if (escapes || forbidden) {
        violations.push({ zone: zone.name, file: repoRelativeFile, specifier: `${specifier} → ${resolved}` });
      }
    } else if ((zone.forbiddenBare ?? []).some((rule) => rule.test(specifier))) {
      violations.push({ zone: zone.name, file: repoRelativeFile, specifier });
    }
  }
  return violations;
}

/** domain's package.json may not declare dependencies of any kind. */
export function checkDomainManifest(manifest) {
  const violations = [];
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      violations.push({
        zone: 'domain must stay dependency-free',
        file: 'packages/domain/package.json',
        specifier: `${section}: ${name}`,
      });
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
        const repoRelativeFile = relative(rootDir, file).replace(/\\/g, '/');
        const source = readFileSync(file, 'utf8');
        violations.push(...findViolationsInFile(source, zone, repoRelativeFile));
      }
    }
  }
  const manifest = JSON.parse(
    readFileSync(join(rootDir, 'packages/domain/package.json'), 'utf8'),
  );
  violations.push(...checkDomainManifest(manifest));
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
