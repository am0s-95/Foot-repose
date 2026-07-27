import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-JS module without type declarations
import { checkBoundaries, checkDomainManifest, findViolationsInFile, ZONES } from './boundaries.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const [frontendZone, domainZone, contractsZone] = ZONES;

describe('modular monolith boundaries', () => {
  it('the repository has no boundary violations', () => {
    expect(checkBoundaries(repoRoot)).toEqual([]);
  });

  it('catches frontends importing the database via bare specifiers', () => {
    const file = 'apps/branch/src/app/page.tsx';
    expect(
      findViolationsInFile("import { createPool } from '@foot-repose/db';", frontendZone, file),
    ).toHaveLength(1);
    expect(findViolationsInFile("import { Pool } from 'pg';", frontendZone, file)).toHaveLength(1);
    expect(findViolationsInFile("import bcrypt from 'bcryptjs';", frontendZone, file)).toHaveLength(1);
  });

  it('catches frontends reaching apps/api or packages/db via relative paths', () => {
    const file = 'apps/branch/src/app/page.tsx';
    expect(
      findViolationsInFile(
        "import { getPool } from '../../../api/src/lib/pool';",
        frontendZone,
        file,
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInFile(
        "import { createPool } from '../../../../packages/db/src/client';",
        frontendZone,
        file,
      ),
    ).toHaveLength(1);
    // Staying inside the app is fine.
    expect(
      findViolationsInFile("import { x } from '../components/thing';", frontendZone, file),
    ).toHaveLength(0);
  });

  it('catches domain escaping its package via relative paths', () => {
    const file = 'packages/domain/src/time.ts';
    expect(
      findViolationsInFile(
        "import { HttpError } from '../../../apps/api/src/lib/http';",
        domainZone,
        file,
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInFile("import { q } from '../../db/src/client';", domainZone, file),
    ).toHaveLength(1);
    expect(
      findViolationsInFile("import { c } from '../../contracts/src/index';", domainZone, file),
    ).toHaveLength(1);
    expect(findViolationsInFile("import { y } from './booking';", domainZone, file)).toHaveLength(0);
  });

  it('catches domain importing anything bare, and manifest dependencies', () => {
    const file = 'packages/domain/src/money.ts';
    expect(findViolationsInFile("import { z } from 'zod';", domainZone, file)).toHaveLength(1);
    expect(checkDomainManifest({})).toEqual([]);
    expect(checkDomainManifest({ dependencies: { zod: '^3.0.0' } })).toHaveLength(1);
    expect(checkDomainManifest({ devDependencies: { pg: '^8' } })).toHaveLength(1);
    expect(checkDomainManifest({ peerDependencies: { react: '*' } })).toHaveLength(1);
  });

  it('catches contracts touching the database, bare or relative', () => {
    const file = 'packages/contracts/src/index.ts';
    expect(
      findViolationsInFile("import { createPool } from '@foot-repose/db';", contractsZone, file),
    ).toHaveLength(1);
    expect(
      findViolationsInFile("import { q } from '../../db/src/client';", contractsZone, file),
    ).toHaveLength(1);
    expect(
      findViolationsInFile("import { t } from '@foot-repose/domain';", contractsZone, file),
    ).toHaveLength(0);
  });

  it('catches dynamic imports and requires too', () => {
    const file = 'apps/admin/src/app/page.tsx';
    expect(
      findViolationsInFile("const db = await import('@foot-repose/db');", frontendZone, file),
    ).toHaveLength(1);
    expect(findViolationsInFile("const pg = require('pg');", frontendZone, file)).toHaveLength(1);
  });
});
