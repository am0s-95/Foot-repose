import { isIP } from 'node:net';

/**
 * The client's address — or `null`, which is the honest answer for this
 * deployment today.
 *
 * `X-Forwarded-For` is written by whoever sends the request. It only means
 * anything if EVERY network path to the origin passes through infrastructure
 * that overwrites or appends to it, and direct access to the origin is
 * impossible. This repository contains no such configuration: there is no proxy
 * config, no origin allowlist and no deployment manifest that pins one. So the
 * default is to trust nothing and return `null` rather than to launder a
 * caller-supplied string into sessions, audit rows and security decisions.
 *
 * `TRUSTED_PROXY_HOPS` opts in, and only once the boundary described below
 * actually exists:
 *
 *   * unset or 0 (the default) — there is no authoritative client address;
 *   * N >= 1 — the RIGHT-MOST N entries are the TRUSTED SUFFIX: each was
 *     appended by one of our own hops, recording the peer it actually saw. The
 *     outermost hop recorded the hop before it, and so on inward, so the FIRST
 *     entry of that suffix — index `length - N` — is the address the outermost
 *     trusted hop observed: the client. With N = 1 that is the last entry.
 *     Everything further left is whatever the caller sent and is ignored.
 *
 * Because the position is what carries the meaning, the chain is NOT compacted:
 * dropping an empty element would slide every later element one place left and
 * silently promote an untrusted value into the authoritative slot. And every
 * entry of the trusted suffix is validated, not just the one we return — a
 * malformed entry there means the chain is not the one this contract describes,
 * so there is nothing to trust anywhere in it.
 *
 * Setting it is a claim about the network, and the application cannot verify
 * that claim — it can only apply it consistently. What must be true first:
 *
 *   * the origin refuses connections that did not come through those N hops
 *     (private networking, an authenticated tunnel, or an IP allowlist);
 *   * each of those N hops appends the address it actually observed;
 *   * no hop copies a caller-supplied value into the position we read.
 *
 * Without the first point, an attacker reaches the origin directly, sends
 * `X-Forwarded-For: <anything>, <anything>` and controls the "authoritative"
 * value — which is why this cannot be enabled by default and why parsing alone
 * proves nothing.
 */
const HOPS_VAR = 'TRUSTED_PROXY_HOPS';
const MAX_HOPS = 8;

export function trustedProxyHops(): number {
  const raw = process.env[HOPS_VAR]?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_HOPS) {
    throw new Error(
      `${HOPS_VAR} must be an integer between 0 and ${MAX_HOPS} (0 = trust nothing); got ${JSON.stringify(raw)}`,
    );
  }
  return hops;
}

/**
 * The authoritative client address, or `null` when this deployment cannot prove
 * one. Never returns a value taken on the caller's word.
 */
export function trustedClientIp(req: Request): string | null {
  const hops = trustedProxyHops();
  if (hops === 0) return null;

  const header = req.headers.get('x-forwarded-for');
  if (header === null) return null;

  // `Headers.get` joins repeated headers with ', ', so one split covers both a
  // single comma-chained header and several separate ones. Trimmed but NOT
  // filtered: positions are the contract, so an empty element stays an element.
  const chain = header.split(',').map((entry) => entry.trim());

  // Fewer entries than trusted hops means the request did not traverse the
  // boundary we were told to expect. Fail closed rather than guess.
  if (chain.length < hops) return null;

  // The whole trusted suffix must look like something our own hops wrote. One
  // empty or malformed entry in it disqualifies the chain outright.
  const suffix = chain.slice(chain.length - hops);
  if (suffix.some((entry) => isIP(entry) === 0)) return null;
  return suffix[0] ?? null;
}
