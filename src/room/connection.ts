// The room session's connection (design §4.1, DEC-074): pi-env's daemon in
// the room, reached by ssh, and the observed seam over it. Shared by every
// program that holds a room session. The invariants of src/room/, which
// shell.ts, source-reader.ts and door.ts refer to:
//
// 1. Built from facts (`RoomConnection`, `Launch`); never knows which client
//    it serves, which kind of door it reached, or which profile is running.
//    A function that needs to ask "which client?" belongs to neither: split
//    it or inject the difference.
// 2. A host-key failure is a trust failure, never downtime: it is recorded
//    (`DaemonConnection.trustFailure`) and surfaced as such; it is never
//    retried as a lost room. Host keys are strict and never written here.
// 3. No pause, profile or tool-error policy inside. Reactions are the
//    caller's, passed in as an observer or a function.

import {
  Connection,
  deployDaemon,
  detectPlatform,
  HostKeyChangedError,
  HostKeyUnknownError,
  isConnectionLost,
  RemoteError,
  RemoteExecutionEnv,
  type RemotePlatform,
  type RemoteInfo,
  type Reply,
  type RequestOptions,
  type SshTarget,
  sshArguments,
} from "@earendil-works/pi-env";
import { setDefined } from "../fields.ts";

/** How the execution environment reaches the room's shell. */
export interface RoomConnection {
  /** The guest's address; a room's is its name, a placeholder the relay ignores. */
  host: string;
  user: string;
  /** The fixed name the room's host keys are stored under in `knownHosts`. */
  hostKeyAlias: string;
  knownHosts: string;
  /** An ssh config file (e.g. the relay's ProxyCommand) instead of `~/.ssh/config`. */
  sshConfig?: string;
  identity?: string;
}

/**
 * The words that start the daemon at path `daemon` in the guest; the
 * execution environment quotes them into ssh's remote command.
 */
export type Launch = (daemon: string) => readonly string[];

/** A launch that runs the daemon itself, with no wrapper. */
export const directLaunch: Launch = (daemon) => [daemon];

/** What an observed connection saw of a lost-connection failure, by type and fields only. */
export interface LostFailure {
  op: string;
  name: string;
  code: string;
  lost: unknown;
}

/** A daemon start refused by strict host-key checking: a trust failure, never downtime. */
export type HostKeyFailure = HostKeyChangedError | HostKeyUnknownError;

/** What a lost connection means: the room is down, or its host key is not trusted. */
export type RoomFault = "unavailable" | "untrusted";

/** The error a caller's tools see for `fault` in place of `error` (design §4.4). */
export type Reword = (fault: RoomFault, error: RemoteError) => RemoteError;

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
 * `inner`, observed: a call failing with `isConnectionLost` is reported (trust
 * failure or loss, by `DaemonConnection.trustFailure`) and awaited before the
 * error is rethrown, through `reword` when given. pi-env's `Connection` has
 * private fields, so the seam is a subclass delegating every public method;
 * its own (never started) connection has no command.
 */
export class ObservedConnection extends Connection {
  readonly #inner: Connection;
  readonly #observer: ConnectionObserver;
  readonly #reword: Reword | undefined;

  constructor(inner: Connection, observer: ConnectionObserver, reword?: Reword) {
    super({ command: [] });
    this.#inner = inner;
    this.#observer = observer;
    this.#reword = reword;
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
        const fault = await this.#lost(describeLost(op, error), error);
        throw this.#reword?.(fault, error) ?? error;
      }
      this.#observer.failed?.(op, error);
      throw error;
    }
  }

  /** Read at every lost failure: one dead start fails every request waiting on it. */
  async #lost(failure: LostFailure, error: RemoteError): Promise<RoomFault> {
    const trust = this.#inner instanceof DaemonConnection ? this.#inner.trustFailure() : undefined;
    if (trust === undefined) {
      await this.#observer.lost(failure, error);
      return "unavailable";
    }
    this.#observer.untrusted(failure, trust);
    return "untrusted";
  }

  override close(): void {
    this.#inner.close();
  }

  override kill(id: number, session: number): void {
    this.#inner.kill(id, session);
  }
}

/**
 * pi-env's remote environment `id` in `cwd` over `connection`, observed by
 * `observer`, its lost failures through `reword` when given: the one way an
 * observed env is built. `connection` is the daemon connection itself, never
 * another `ObservedConnection` (refused): the trust check reads the inner
 * connection, so a nested wrapper reports a host-key refusal as a loss
 * (design §4.3, RV-035 F-4).
 */
export function observedEnv(
  connection: Connection,
  observer: ConnectionObserver,
  { id, cwd, reword }: { id: string; cwd: string; reword?: Reword },
): RemoteExecutionEnv {
  if (connection instanceof ObservedConnection) {
    throw new Error(
      `${id}: an ObservedConnection must wrap the daemon connection, not another ObservedConnection`,
    );
  }
  return new RemoteExecutionEnv({
    connection: new ObservedConnection(connection, observer, reword),
    id,
    cwd,
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
 * after it, or a start racing a reader, leaves it standing (fail closed). Each
 * caller makes its own, so the record is that caller's.
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
 * A daemon connection into the room. Lazy: nothing runs until the
 * first request, and a failed start fails that request (`spawn_error`); the
 * next request tries again. Host keys must already be trusted in `knownHosts`.
 */
export const daemonConnection = (
  room: RoomConnection,
  launch: Launch,
  helpers?: DaemonHelpers,
): DaemonConnection => new DaemonConnection(daemonCommand(room, launch, helpers));
