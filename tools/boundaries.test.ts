import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-JS module without type declarations
import { checkBoundaries, findViolationsInSource, ZONES } from './boundaries.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('modular monolith boundaries', () => {
  it('the repository has no boundary violations', () => {
    expect(checkBoundaries(repoRoot)).toEqual([]);
  });

  it('would fail if a frontend imported the database package', () => {
    const frontendZone = ZONES[0];
    expect(
      findViolationsInSource("import { createPool } from '@foot-repose/db';", frontendZone),
    ).toHaveLength(1);
    expect(findViolationsInSource("import { Pool } from 'pg';", frontendZone)).toHaveLength(1);
    expect(findViolationsInSource("import bcrypt from 'bcryptjs';", frontendZone)).toHaveLength(1);
  });

  it('would fail if domain imported anything non-relative', () => {
    const domainZone = ZONES[1];
    expect(findViolationsInSource("import { z } from 'zod';", domainZone)).toHaveLength(1);
    expect(
      findViolationsInSource("import { x } from '@foot-repose/contracts';", domainZone),
    ).toHaveLength(1);
    expect(findViolationsInSource("import { y } from './booking';", domainZone)).toHaveLength(0);
  });

  it('would fail if contracts imported the database', () => {
    const contractsZone = ZONES[2];
    expect(
      findViolationsInSource("import { createPool } from '@foot-repose/db';", contractsZone),
    ).toHaveLength(1);
    expect(
      findViolationsInSource("import { t } from '@foot-repose/domain';", contractsZone),
    ).toHaveLength(0);
  });

  it('catches dynamic imports and requires too', () => {
    const frontendZone = ZONES[0];
    expect(findViolationsInSource("const db = await import('@foot-repose/db');", frontendZone)).toHaveLength(1);
    expect(findViolationsInSource("const pg = require('pg');", frontendZone)).toHaveLength(1);
  });
});
