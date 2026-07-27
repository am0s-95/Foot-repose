/** Lazy env access so `next build` never requires runtime secrets. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  get authSecret(): string {
    return required('AUTH_SECRET');
  },
};
