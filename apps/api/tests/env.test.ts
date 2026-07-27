import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/lib/env';

const ORIGINAL_SECRET = process.env.AUTH_SECRET;

afterEach(() => {
  process.env.AUTH_SECRET = ORIGINAL_SECRET;
});

describe('AUTH_SECRET validation', () => {
  it('accepts the configured test secret', () => {
    expect(env.authSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('rejects a missing secret', () => {
    delete process.env.AUTH_SECRET;
    expect(() => env.authSecret).toThrow(/Missing required environment variable/);
  });

  it('rejects short secrets', () => {
    process.env.AUTH_SECRET = 'too-short';
    expect(() => env.authSecret).toThrow(/at least 32 characters/);
  });

  it('rejects the change-me placeholder even when long enough', () => {
    process.env.AUTH_SECRET = 'change-me-change-me-change-me-change-me';
    expect(() => env.authSecret).toThrow(/placeholder/);
  });
});

describe('ALLOWED_ORIGINS', () => {
  it('defaults to the three local frontends', () => {
    expect(env.allowedOrigins).toContain('http://localhost:3001');
    expect(env.allowedOrigins).toHaveLength(3);
  });
});
