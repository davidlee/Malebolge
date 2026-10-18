// A job's execution environment (design §5.2, DEC-054, amended DEC-055):
// pi-env's remote environment over a pi-env daemon in the room, reached by
// ssh. The connection is the runner's own `JobConnection`, so a lost
// connection is seen by type, where it is still typed, before pi-durable turns
// it into tool-result text (PHASE-09 fills the observer). The connection facts
// come from room.ts's `roomConnection` alone (EX-3).

import {
  Connection,
  isConnectionLost,
  RemoteError,
  RemoteExecutionEnv,
  type RemoteInfo,
  type Reply,
  type RequestOptions,
  type SshTarget,
  sshConnection,
} from "@earendil-works/pi-env";
import { setDefined } from "../fields.ts";
import type { RoomConnection } from "./room.ts";

/** What the job's connection saw of a lost-connection failure, by type and fields only. */
export interface LostFailure {
  op: string;
  name: string;
  code: string;
  lost: unknown;
}

export interface ConnectionObserver {
  /** A call failed because the connection was lost; settles before the failure is rethrown. */
  lost: (failure: LostFailure, error: unknown) => Promise<void>;
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
        await this.#observer.lost(describeLost(op, error), error);
      } else {
        this.#observer.failed?.(op, error);
      }
      throw error;
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
  /** The daemon connection; production's is `roomDaemon`. */
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

/**
 * A pi-env daemon connection into the room. Lazy: nothing runs until the first
 * request, and a failed start fails that request (`spawn_error`); the next
 * request tries again. Host keys must already be trusted in `knownHosts`.
 */
export const roomDaemon = (room: RoomConnection): Connection =>
  sshConnection(sshTarget(room)).connection;
