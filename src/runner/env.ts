// A job's execution environment (design §5.2, DEC-054, amended DEC-055):
// pi-env's remote environment over a pi-env daemon in the room, reached by
// ssh. The connection is the runner's own `JobConnection`, so a lost
// connection is seen by type, where it is still typed, before pi-durable turns
// it into tool-result text (PHASE-09 fills the observer). The connection facts
// come from room.ts alone (EX-3): `roomConnection`, and the launch words
// `daemonLaunch` gives; this file builds the one daemon command from them,
// never knowing which kind of room it reaches (EX-4). Host keys are strict
// and never written here; a start that finds the key unknown or changed is a
// trust failure, not a lost room (EX-5).

import {
  Connection,
  deployDaemon,
  detectPlatform,
  HostKeyChangedError,
  HostKeyUnknownError,
  isConnectionLost,
  type RemotePlatform,
  RemoteError,
  RemoteExecutionEnv,
  type RemoteInfo,
  type Reply,
  type RequestOptions,
  type SshTarget,
  sshArguments,
} from "@earendil-works/pi-env";
import { setDefined } from "../fields.ts";
import type { Launch, RoomConnection } from "./room.ts";

/** What the job's connection saw of a lost-connection failure, by type and fields only. */
export interface LostFailure {
  op: string;
  name: string;
  code: string;
  lost: unknown;
}

/** A daemon start refused by strict host-key checking: a trust failure, never downtime. */
export type HostKeyFailure = HostKeyChangedError | HostKeyUnknownError;

export interface ConnectionObserver {
  /** A call failed because the connection was lost; settles before the failure is rethrown. */
  lost: (failure: LostFailure, error: unknown) => Promise<void>;
  /** As `lost`, but the start that failed found the room's host key unknown or changed. */
  untrusted: (failure: LostFailure, trust: HostKeyFailure) => void;
  /** Any other failure, for the record only. */
  failed?: (op: string, error: unknown) => void;
  /** A request was sent (its id and daemon session). */
  started?: (op: string, id: number, session: number) => void;
}

const describeLost = (op: string, error: RemoteError): LostFailure => ({
  op,
  name: error.name,
  code: error.code,
  lost: error.fields["lost"],
});

/**
 * `inner`, observed: a call that fails with `isConnectionLost` reports it and
 * awaits the report before rethrowing. pi-env's `Connection` has private
 * fields, so the seam is a subclass delegating every public method; its own
 * (never started) connection has no command.
 */
export class JobConnection extends Connection {
  readonly #inner: Connection;
  readonly #observer: ConnectionObserver;

  constructor(inner: Connection, observer: ConnectionObserver) {
    super({ command: [] });
    this.#inner = inner;
    this.#observer = observer;
  }

  // `info` and `session` connect too: a file op resolving a path can lose the
  // connection there before it sends any request.
  override info(): Promise<RemoteInfo> {
    return this.#observe("info", () => this.#inner.info());
  }

  override session(): Promise<number> {
    return this.#observe("session", () => this.#inner.session());
  }

  override request(
    op: string,
    json: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<Reply> {
    const started = this.#observer.started;
    const observed: RequestOptions = {
      ...options,
      onStart: (id, session) => {
        options.onStart?.(id, session);
        started?.(op, id, session);
      },
    };
    return this.#observe(op, () => this.#inner.request(op, json, observed));
  }

  async #observe<T>(op: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      // isConnectionLost is `instanceof RemoteError && fields.lost === true`; never the message.
      if (error instanceof RemoteError && isConnectionLost(error)) {
        await this.#lost(describeLost(op, error), error);
      } else {
        this.#observer.failed?.(op, error);
      }
      throw error;
    }
  }

  /** Read at every lost failure: one dead start fails every request waiting on it. */
  async #lost(failure: LostFailure, error: RemoteError): Promise<void> {
    const trust = this.#inner instanceof DaemonConnection ? this.#inner.trustFailure() : undefined;
    if (trust === undefined) {
      await this.#observer.lost(failure, error);
    } else {
      this.#observer.untrusted(failure, trust);
    }
  }

  override close(): void {
    this.#inner.close();
  }

  override kill(id: number, session: number): void {
    this.#inner.kill(id, session);
  }
}

export interface JobEnvOptions {
  jobId: string;
  /** The repo's clone in the room (`guest_path`). */
  cwd: string;
  /** The daemon connection; production's is `daemonConnection`. */
  connection: Connection;
  observer: ConnectionObserver;
}

/** Job `jobId`'s environment: `connection` behind a `JobConnection` (EX-7). */
export function jobEnv(options: JobEnvOptions): RemoteExecutionEnv {
  return new RemoteExecutionEnv({
    connection: new JobConnection(options.connection, options.observer),
    id: `pi-env:job-${options.jobId}`,
    cwd: options.cwd,
  });
}

/** pi-env's ssh target for the room. */
export const sshTarget = (room: RoomConnection): SshTarget =>
  setDefined<SshTarget>(
    {
      host: room.host,
      user: room.user,
      knownHostsFile: room.knownHosts,
      hostKeyAlias: room.hostKeyAlias,
    },
    { configFile: room.sshConfig, identityFile: room.identity },
  );

/** pi-env's start steps, a seam for tests; `ssh` is the program. */
export interface DaemonHelpers {
  ssh: string;
  detectPlatform: (target: SshTarget) => Promise<RemotePlatform>;
  deployDaemon: (target: SshTarget, remote: RemotePlatform) => Promise<string>;
}

const PI_ENV_HELPERS: DaemonHelpers = {
  ssh: "ssh",
  detectPlatform,
  deployDaemon,
};

/** `text` as one POSIX shell word. */
const quotePosix = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The daemon command: pi-env's `sshConnection` recipe, strict, with the launch
 * word `launch` gives. The remote is detected at the first start and the
 * daemon verified or deployed at every start, both strict (pi-env's default).
 */
export function daemonCommand(
  room: RoomConnection,
  launch: Launch,
  helpers: DaemonHelpers = PI_ENV_HELPERS,
): () => Promise<string[]> {
  const target = sshTarget(room);
  let remote: RemotePlatform | undefined;
  return async () => {
    remote ??= await helpers.detectPlatform(target);
    const daemon = await helpers.deployDaemon(target, remote);
    return [helpers.ssh, ...sshArguments(target, true), launch(daemon).map(quotePosix).join(" ")];
  };
}

/** A daemon connection's last start, as far as host-key trust goes. */
interface TrustRecord {
  failure: HostKeyFailure | undefined;
}

const isHostKeyFailure = (error: unknown): error is HostKeyFailure =>
  error instanceof HostKeyChangedError || error instanceof HostKeyUnknownError;

/**
 * A daemon connection that keeps its own trust record. pi-env rewraps a
 * failed start as a lost `spawn_error`, erasing the type, so the start is
 * caught here first and its host-key failure recorded. Only a start whose
 * command is built (host key checked) clears it: a failure of another kind
 * after it, or a start racing a reader, leaves it standing (fail closed). One
 * per job (`connect`), so the record is per job.
 */
export class DaemonConnection extends Connection {
  readonly #trust: TrustRecord;

  constructor(command: () => Promise<readonly string[]>) {
    const trust: TrustRecord = { failure: undefined };
    super({
      command: async () => {
        try {
          const built = await command();
          trust.failure = undefined;
          return built;
        } catch (error) {
          if (isHostKeyFailure(error)) {
            trust.failure = error;
          }
          throw error;
        }
      },
    });
    this.#trust = trust;
  }

  /** The host-key failure on record: since the last start that passed the key check. */
  trustFailure(): HostKeyFailure | undefined {
    return this.#trust.failure;
  }
}

/**
 * The job's daemon connection into the room. Lazy: nothing runs until the
 * first request, and a failed start fails that request (`spawn_error`); the
 * next request tries again. Host keys must already be trusted in `knownHosts`.
 */
export const daemonConnection = (
  room: RoomConnection,
  launch: Launch,
  helpers?: DaemonHelpers,
): DaemonConnection => new DaemonConnection(daemonCommand(room, launch, helpers));
