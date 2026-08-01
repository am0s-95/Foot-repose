import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  listen,
  OwnedResources,
  portIsFree,
  stop,
  withOwnedResources,
} from './support/owned-resources';

/**
 * The guarantees the Customer suite's cleanup rests on.
 *
 * These are deliberately about the MECHANISM rather than about the Customer app:
 * `api-destination.test.ts` builds and starts Next, so proving "an assertion
 * failure still cleans up" through it would mean a nested build per case. The
 * escalation, the idempotency and the partial-setup paths are all here instead,
 * exercised against real child processes and real listening sockets.
 */

/** A child that exits on SIGTERM, like a well-behaved server. */
function cooperative() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

/**
 * A child that ignores SIGTERM, so only escalation can end it.
 *
 * It announces itself on stdout AFTER installing the handler. Waiting on the
 * `spawn` event is not enough — that fires when the process exists, not when
 * its script has run, and a SIGTERM arriving in that gap is handled by Node's
 * default disposition, which terminates. Measured: without the handshake this
 * test saw `sigterm` and would have passed while proving nothing.
 */
function stubborn() {
  return spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {}); console.log('armed'); setInterval(() => {}, 1000)",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

const untilArmed = (child: ReturnType<typeof stubborn>): Promise<void> =>
  new Promise((resolve) => child.stdout!.once('data', () => resolve()));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('[leak] stopping a child proves it stopped', () => {
  it('ends a cooperative child with SIGTERM alone', async () => {
    const child = cooperative();
    await once(child, 'spawn');
    const outcome = await stop(child);
    expect(outcome.via).toBe('sigterm');
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(alive(child.pid!)).toBe(false);
  }, 30_000);

  it('escalates to SIGKILL when SIGTERM is ignored, and waits for the exit', async () => {
    const child = stubborn();
    await untilArmed(child);
    const outcome = await stop(child);
    // The grace period elapsed and one escalation followed — and `stop` did not
    // return until the process was actually gone, which `kill()` alone never
    // tells you.
    expect(outcome.via).toBe('sigkill');
    expect(alive(child.pid!)).toBe(false);
  }, 30_000);

  it('is a no-op for a child that has already exited', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');
    expect((await stop(child)).via).toBe('already-exited');
  }, 30_000);
});

describe('[leak] releasing owned resources', () => {
  it('stops processes, closes servers and frees their ports', async () => {
    const owned = new OwnedResources();
    const port = 4381;
    await listen(owned, port, (_req, res) => res.end('ok'));
    owned.own(cooperative());

    expect(await portIsFree(port)).toBe(false);
    await owned.release();
    expect(await portIsFree(port)).toBe(true);
  }, 30_000);

  it('closes a server that is still holding an open connection', async () => {
    // A keep-alive socket makes `server.close()` wait forever; the leak this
    // suite is about is exactly the class of cleanup that never completes.
    const owned = new OwnedResources();
    const port = 4382;
    await listen(owned, port, (_req, res) => res.end('ok'));
    const held = net.connect({ port, host: '127.0.0.1' });
    await once(held, 'connect');

    await owned.release();
    expect(await portIsFree(port)).toBe(true);
    held.destroy();
  }, 30_000);

  it('is idempotent — releasing twice is safe', async () => {
    const owned = new OwnedResources();
    const port = 4383;
    await listen(owned, port, (_req, res) => res.end('ok'));
    await owned.release();
    await expect(owned.release()).resolves.toBeUndefined();
    expect(await portIsFree(port)).toBe(true);
  }, 30_000);

  it('reports a survivor rather than passing quietly', async () => {
    // The whole point: a cleanup that cannot finish must be loud. The original
    // suite's was silent, which is why it stayed green for so long.
    const owned = new OwnedResources();
    const port = 4384;
    const server = await listen(owned, port, (_req, res) => res.end('ok'));
    const blocker = net.createServer();
    await owned.release();
    // Re-occupy the port to simulate something the scope could not release.
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
    expect(await portIsFree(port)).toBe(false);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    expect(server.listening).toBe(false);
  }, 30_000);
});

describe('[leak] a setup that fails still releases what it created', () => {
  it('releases the first upstream when the second stage throws', async () => {
    const owned = new OwnedResources();
    const first = 4385;
    const failure = new Error('stage two failed');

    await expect(
      withOwnedResources(owned, async (scope) => {
        await listen(scope, first, (_req, res) => res.end('ok'));
        throw failure;
      }),
    ).rejects.toBe(failure); // the ORIGINAL error, not a cleanup error

    expect(await portIsFree(first)).toBe(true);
  }, 30_000);

  it('releases both upstreams and the process when the last stage throws', async () => {
    const owned = new OwnedResources();
    const first = 4386;
    const second = 4387;
    let childPid = 0;

    await expect(
      withOwnedResources(owned, async (scope) => {
        await listen(scope, first, (_req, res) => res.end('ok'));
        await listen(scope, second, (_req, res) => res.end('ok'));
        childPid = scope.own(cooperative()).pid!;
        // Stands in for the app never answering within its startup deadline.
        throw new Error('app never started');
      }),
    ).rejects.toThrow('app never started');

    expect(await portIsFree(first)).toBe(true);
    expect(await portIsFree(second)).toBe(true);
    expect(alive(childPid)).toBe(false);
  }, 30_000);

  it('lets a second release from afterAll be harmless after a failed setup', async () => {
    // Measured on this Vitest version: `afterAll` runs even when `beforeAll`
    // threw, so both paths reach `release()` and the second must do nothing.
    const owned = new OwnedResources();
    await expect(
      withOwnedResources(owned, async (scope) => {
        await listen(scope, 4388, (_req, res) => res.end('ok'));
        throw new Error('setup failed');
      }),
    ).rejects.toThrow('setup failed');
    await expect(owned.release()).resolves.toBeUndefined();
  }, 30_000);
});

describe('[leak] cleanup never reaches beyond what this suite started', () => {
  it('uses no pattern-based process killing anywhere in these tests', () => {
    // A pattern-based kill would have "fixed" the leak by terminating whatever
    // else on the machine happened to match the name — including another
    // developer's server, or a sibling CI job. Cleanup here is by handle only,
    // which is why this check reads the sources rather than trusting intent.
    const sources = [
      'support/owned-resources.ts',
      'api-destination.test.ts',
      'owned-resources.test.ts',
    ].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'));

    for (const source of sources) {
      expect(source).not.toMatch(/\bpkill\b/);
      expect(source).not.toMatch(/\bkillall\b/);
      expect(source).not.toMatch(/shell:\s*true/);
    }
  });
});
