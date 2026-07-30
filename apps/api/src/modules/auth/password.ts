import { Worker } from 'node:worker_threads';
// Not used on this thread — it is here so the dependency tracer can SEE it.
// The worker requires bcryptjs from a source string that is opaque to the
// bundler by design, and an opaque require traces nothing: a standalone build
// shipped without bcryptjs and login died at runtime while every unit test and
// `next start` in the checkout stayed green. This import, plus the
// `serverExternalPackages` entry, is what puts the package in the artifact.
// The deployment-artifact test is what proves it, and would fail without it.
import 'bcryptjs';
import { VERIFY_WORKER_SOURCE } from './verify-worker-source';

/**
 * Password verification for the login path.
 *
 * The threat model is the plain one: an UNAUTHENTICATED caller decides how often
 * this runs. That is what makes a blocking implementation a denial-of-service
 * surface rather than a latency note.
 *
 * `bcrypt.compareSync` ran the whole key expansion in one synchronous call, so
 * while it ran this process answered nothing — no other request, no timer, no
 * health check. Measured on this exact dependency (bcryptjs 2.4.3, cost 10):
 *
 *   * `compareSync`  — 133 ms, 0 timer ticks observed during it;
 *   * `compare`      — 89 ms,  1 timer tick.
 *
 * So bcryptjs's promise-returning `compare` is NOT a fix: it chains
 * `process.nextTick`, and a nextTick chain runs before the loop advances. One
 * tick per 89 ms is not yielding. Neither is wrapping the sync call in a
 * resolved promise.
 *
 * The work therefore moves off this thread entirely, onto a small pool of
 * worker threads. bcrypt hashes stay exactly as they are — no re-hashing, no
 * format change, nothing invalidated. Inside a worker the call is deliberately
 * synchronous: blocking a thread that exists only for this is the mechanism.
 *
 * Yielding is not the same as being free. Each verification still costs CPU, and
 * because there is no authoritative client address (see `trustedClientIp`),
 * per-identifier throttling cannot bound how many DISTINCT emails an attacker
 * tries. So verification is admitted through an explicit gate of fixed size with
 * NO queue: over it, the attempt is refused deterministically.
 */
export const PASSWORD_COST = 10;

/**
 * A real bcrypt hash at PASSWORD_COST of a value no caller would be guessing.
 * A constant, so module load performs no hashing at all — the previous
 * `hashSync` at import time blocked startup on every cold start. A test asserts
 * the embedded cost still equals PASSWORD_COST, so the unknown-email path cannot
 * quietly become cheaper than the real one.
 */
export const DUMMY_HASH = '$2a$10$RG6/QoiACDB3W3UyUT7kiuZv7Bhp.xfU49p6P0Clid7cxqySYIOjC';

/** Verifications admitted at once — also the worker-pool size, since each worker
 * handles exactly one at a time. Small on purpose: this is the only thing
 * between an unauthenticated caller and this process's CPU. */
export const MAX_CONCURRENT_VERIFICATIONS = 4;

export class VerificationOverloadError extends Error {
  constructor() {
    super('Password verification capacity is saturated');
    this.name = 'VerificationOverloadError';
  }
}

/**
 * The bound itself, as a first-class thing rather than a counter hidden in a
 * closure. Production takes a permit in `verifyPassword`; tests take permits the
 * same way, which is what makes "the gate is full" a state they can establish
 * exactly instead of racing a real comparison to stay busy.
 */
class VerificationGate {
  private used = 0;

  constructor(readonly size: number) {}

  inUse(): number {
    return this.used;
  }

  tryAcquire(): boolean {
    if (this.used >= this.size) return false;
    this.used += 1;
    return true;
  }

  release(): void {
    if (this.used > 0) this.used -= 1;
  }
}

export const verificationGate = new VerificationGate(MAX_CONCURRENT_VERIFICATIONS);

interface Slot {
  worker: Worker;
  busy: boolean;
  pending: Map<number, { resolve: (matched: boolean) => void; reject: (error: Error) => void }>;
}

const slots: Slot[] = [];
let nextJobId = 0;

function spawn(): Slot {
  const worker = new Worker(VERIFY_WORKER_SOURCE, { eval: true });
  const slot: Slot = { worker, busy: false, pending: new Map() };
  worker.on('message', (message: { id: number; matched?: boolean; failure?: string }) => {
    const waiter = slot.pending.get(message.id);
    if (!waiter) return;
    slot.pending.delete(message.id);
    slot.busy = false;
    if (message.failure !== undefined) waiter.reject(new Error(message.failure));
    else waiter.resolve(message.matched === true);
  });
  const fail = (error: Error): void => {
    for (const waiter of slot.pending.values()) waiter.reject(error);
    slot.pending.clear();
    slot.busy = false;
    // A dead worker must not keep a slot permanently busy or permanently
    // present: drop it so the next attempt spawns a healthy replacement.
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (code !== 0) fail(new Error(`Password verification worker exited with code ${code}`));
  });
  // The pool must never be the reason the process stays alive.
  worker.unref();
  slots.push(slot);
  return slot;
}

/** An idle worker. The gate has already guaranteed there are at most `size`
 * verifications in flight, so one is always available or spawnable. */
function acquireWorker(): Slot {
  return slots.find((slot) => !slot.busy) ?? spawn();
}

/**
 * Compare a password against a stored hash, always paying the full cost.
 *
 * `hash === null` (unknown email) still performs a real comparison against
 * DUMMY_HASH at the same work factor and then returns false, so an unknown
 * address cannot be told apart from a wrong password by timing.
 *
 * Throws `VerificationOverloadError` when the gate is full. The caller must
 * answer that identically to throttling — never with anything that reveals
 * whether the account exists.
 */
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!verificationGate.tryAcquire()) throw new VerificationOverloadError();
  try {
    const slot = acquireWorker();
    slot.busy = true;
    const id = (nextJobId += 1);
    const matched = await new Promise<boolean>((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage({ id, password, hash: hash ?? DUMMY_HASH });
    });
    return hash === null ? false : matched;
  } finally {
    verificationGate.release();
  }
}

/** Release the pool. Tests call this so a run does not leave threads behind. */
export async function shutdownPasswordWorkers(): Promise<void> {
  const closing = slots.map((slot) => slot.worker.terminate());
  slots.length = 0;
  await Promise.all(closing);
}
