import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import net from 'node:net';

/**
 * Test-only ownership of the processes and servers a suite starts.
 *
 * The defect this exists to close: `apps/customer/tests/api-destination.test.ts`
 * started its server with `spawn('npx', ['next', 'start', ...])` and cleaned up
 * with a bare `app?.kill('SIGKILL')`. Measured on main 2773b7c, that produced
 * this chain — the retained handle is the FIRST of three:
 *
 *   npm exec next start --port 3291   (pid 3953, the retained ChildProcess)
 *     sh -c next start --port 3291    (pid 3965)
 *       next-server (v15.5.22)        (pid 3966, the actual server)
 *
 * SIGKILL to 3953 killed 3953 alone. 3965 reparented to init and 3966 kept
 * serving; port 3291 still accepted connections 23 seconds after the suite
 * exited 0. The suite was green and its cleanup contract was false.
 *
 * Two things fix it, and both are needed:
 *
 *   * the retained handle must BE the server — resolve the Next CLI and run it
 *     with this Node, so there is no launcher and no shell in between;
 *   * cleanup must be awaited and verified — a delivered signal is not an exit,
 *     so `stop` waits for the exit event and escalates once if it has to.
 */

/** How long a process gets to honour SIGTERM before SIGKILL. */
const GRACE_MS = 5_000;
/** How long a killed process gets to actually disappear before this gives up. */
const REAP_MS = 5_000;

export interface StopOutcome {
  /** 'already-exited' | 'sigterm' | 'sigkill' — how it actually ended. */
  via: 'already-exited' | 'sigterm' | 'sigkill';
}

/**
 * End a child process and PROVE it ended.
 *
 * `child.kill()` returns whether the signal was delivered, which says nothing
 * about whether the process died — that is exactly the assumption that let the
 * leak pass as clean. SIGTERM first so a server can close its listeners, then
 * one escalation, and an awaited exit either way.
 */
export async function stop(child: ChildProcess): Promise<StopOutcome> {
  if (child.exitCode !== null || child.signalCode !== null) return { via: 'already-exited' };

  const exited = once(child, 'exit');
  child.kill('SIGTERM');

  if (await settles(exited, GRACE_MS)) return { via: 'sigterm' };

  const killed = once(child, 'exit');
  child.kill('SIGKILL');
  if (!(await settles(killed, REAP_MS))) {
    // Loud on purpose. A cleanup that quietly fails is what produced the
    // original green-but-leaking suite.
    throw new Error(`process ${child.pid} survived SIGTERM and SIGKILL`);
  }
  return { via: 'sigkill' };
}

async function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Close a server and every connection it is holding, awaited. */
export async function closeServer(server: Server, sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  // `close` waits for open connections, so the sockets go first — otherwise a
  // keep-alive connection makes this hang until the hook times out.
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** True when nothing holds the port, proven by binding rather than by failing
 * to connect — a refused connection can also mean a firewall or a race. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

interface OwnedServer {
  server: Server;
  sockets: Set<net.Socket>;
  port: number;
}

/**
 * Everything a suite has started so far.
 *
 * Resources are recorded the moment they exist, not at the end of a successful
 * setup — a setup that fails half way still owns what it already created. The
 * original test had no such record: a failure between the two upstreams and the
 * app left whatever had started with nobody responsible for it.
 */
export class OwnedResources {
  private readonly children: ChildProcess[] = [];
  private readonly servers: OwnedServer[] = [];
  private releasing: Promise<void> | null = null;

  own(child: ChildProcess): ChildProcess {
    this.children.push(child);
    return child;
  }

  ownServer(server: Server, sockets: Set<net.Socket>, port: number): void {
    this.servers.push({ server, sockets, port });
  }

  get processCount(): number {
    return this.children.length;
  }

  get serverPorts(): number[] {
    return this.servers.map((s) => s.port);
  }

  /**
   * Stop everything, and confirm every port is free afterwards.
   *
   * Idempotent, and safe to call from both a failed setup and `afterAll` —
   * measured on this Vitest version, `afterAll` runs even when `beforeAll`
   * threw, so both paths reach here and the second call must be a no-op.
   */
  release(): Promise<void> {
    this.releasing ??= this.releaseOnce();
    return this.releasing;
  }

  private async releaseOnce(): Promise<void> {
    const failures: string[] = [];

    for (const child of this.children) {
      try {
        await stop(child);
      } catch (error) {
        failures.push(`child ${child.pid}: ${(error as Error).message}`);
      }
    }

    for (const owned of this.servers) {
      try {
        await closeServer(owned.server, owned.sockets);
      } catch (error) {
        failures.push(`server :${owned.port}: ${(error as Error).message}`);
      }
    }

    for (const port of this.serverPorts) {
      if (!(await portIsFree(port))) failures.push(`port ${port} still bound after cleanup`);
    }

    if (failures.length > 0) throw new Error(`cleanup incomplete: ${failures.join('; ')}`);
  }
}

/**
 * Run a setup that creates resources, and release whatever it managed to create
 * if it throws — then rethrow the ORIGINAL failure, because the setup error is
 * what the reader needs, not a cleanup error that followed it.
 */
export async function withOwnedResources<T>(
  owned: OwnedResources,
  setup: (owned: OwnedResources) => Promise<T>,
): Promise<T> {
  try {
    return await setup(owned);
  } catch (error) {
    await owned.release().catch(() => undefined);
    throw error;
  }
}

/** An HTTP test server whose connections are tracked, so closing it terminates. */
export function listen(
  owned: OwnedResources,
  port: number,
  handler: Parameters<typeof createServer>[1],
): Promise<Server> {
  const sockets = new Set<net.Socket>();
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  owned.ownServer(server, sockets, port);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/**
 * Start a Next server as a DIRECT child.
 *
 * `npx next start` is what created the leak: npm's launcher spawns a shell,
 * which spawns the real server, so the handle the test held was two levels
 * above the process that mattered. Resolving the CLI and running it with this
 * Node makes the retained ChildProcess the server itself, which is what lets
 * `stop` mean anything. Spawning through a shell is avoided for the same
 * reason — it would reintroduce exactly the intermediate process this removes.
 */
export function startNext(
  owned: OwnedResources,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; onLog: (chunk: string) => void },
): ChildProcess {
  const cli = require.resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => options.onLog(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => options.onLog(chunk.toString()));
  return owned.own(child);
}
