import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

/** Load .env from the repo root (works regardless of cwd), then from cwd. */
export function loadEnv(): void {
  config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
  config();
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
