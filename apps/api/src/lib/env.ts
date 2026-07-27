/** Lazy env access so `next build` never requires runtime secrets. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const DEFAULT_ALLOWED_ORIGINS =
  'http://localhost:3001,http://localhost:3002,http://localhost:3003';

export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  get authSecret(): string {
    const value = required('AUTH_SECRET');
    if (value.length < 32) {
      throw new Error('AUTH_SECRET must be at least 32 characters — generate one with `openssl rand -hex 32`');
    }
    if (value.toLowerCase().includes('change-me')) {
      throw new Error('AUTH_SECRET is still the placeholder value — generate a real secret');
    }
    return value;
  },
  /** Browser origins allowed to send state-changing requests (CSRF guard). */
  get allowedOrigins(): string[] {
    return (process.env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  },
};
