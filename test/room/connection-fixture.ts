// pi-env connections for tests: a real local daemon, one that is lost before
// it starts, one that fails chosen calls, and a room whose host key changes
// mid-run; pi-env's start steps, faked; and observers that ignore or record.

import {
  Connection,
  localDaemon,
  RemoteError,
  type RemoteInfo,
  type RemotePlatform,
  type Reply,
  type RequestOptions,
  type SshTarget,
} from "@earendil-works/pi-env";
import {
  type ConnectionObserver,
  DaemonConnection,
  type DaemonHelpers,
} from "../../src/room/connection.ts";

/** An observer that reacts to nothing. */
export const ignoreLost: ConnectionObserver = {
  lost: () => Promise.resolve(),
  untrusted: () => undefined,
};

/** An observer that records what it was told, in order. */
export function recordingObserver(): ConnectionObserver & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    lost: (failure): Promise<void> => {
      seen.push(`lost ${failure.code}`);
      return Promise.resolve();
    },
    untrusted: (failure, trust): void => {
      seen.push(`untrusted ${failure.code} ${trust.constructor.name}`);
    },
  };
}

/**
 * A real local pi-env daemon (the binary pi-env ships for this machine). With
 * `path`, the daemon starts with that PATH, so its execs resolve binaries
 * from it (a fake first on `path` is the one run).
 */
export const localConnection = (path?: string): Connection =>
  new Connection({
    command: path === undefined ? [localDaemon()] : ["env", `PATH=${path}`, localDaemon()],
  });

/** `dir` first, then the test process's PATH. */
export const pathWith = (dir: string): string => `${dir}:${process.env["PATH"] ?? ""}`;

/** A daemon that exits before it is ready: pi-env's own lost failure, deterministically. */
export const lostConnection = (): Connection => new Connection({ command: ["sh", "-c", "exit 3"] });

/** The remote pi-env's detection answers in a test, and where the daemon is deployed. */
export const REMOTE: RemotePlatform = {
  platform: "linux",
  arch: "x64",
  home: "/home/agent",
  warnings: [],
};
export const DAEMON = "/home/agent/.pi/mobile/tools/pi-env-0123";

/** pi-env's start steps, faked: the targets each was given; `failure`, if given, fails every deploy. */
export function fakeHelpers(
  ssh = "ssh",
  failure?: () => Error,
): DaemonHelpers & { detected: SshTarget[]; deployed: SshTarget[] } {
  const detected: SshTarget[] = [];
  const deployed: SshTarget[] = [];
  return {
    ssh,
    detected,
    deployed,
    detectPlatform: (target): Promise<RemotePlatform> => {
      detected.push(target);
      return Promise.resolve(REMOTE);
    },
    deployDaemon: (target, remote): Promise<string> => {
      deployed.push(target);
      if (failure !== undefined) {
        return Promise.reject(failure());
      }
      return Promise.resolve(remote === REMOTE ? DAEMON : "unexpected-remote");
    },
  };
}

/** The text pi-env gives a lost connection. */
export const LOST_TEXT = "pi-env connection lost";

/** A failure typed as pi-env types a lost connection (`isConnectionLost`). */
export const lostError = (code = "unknown"): RemoteError =>
  new RemoteError({ code, message: LOST_TEXT, lost: true });

/** What a `FailingConnection` call is: `info`, `session`, or a request's op and body. */
export interface ConnectionCall {
  op: string;
  json?: Record<string, unknown>;
}

/** Which calls fail, and with what; `undefined` lets the call through. */
export type FailWhen = (call: ConnectionCall) => Error | undefined;

const STUB_INFO: RemoteInfo = {
  protocol: 1,
  version: "0",
  os: "linux",
  arch: "x86_64",
  home: "/tmp",
  tmpdir: "/tmp",
  separator: "/",
  cwd: "/tmp",
  driveCwds: {},
  pid: 0,
};

/**
 * `inner`, except the calls `failWhen` names, which reject with its error.
 * Without `inner` nothing runs: `info` and `session` answer a stub, and a
 * request that does not fail is refused.
 */
export class FailingConnection extends Connection {
  readonly #failWhen: FailWhen;
  readonly #inner: Connection | undefined;

  constructor(failWhen: FailWhen, inner?: Connection) {
    super({ command: [] });
    this.#failWhen = failWhen;
    this.#inner = inner;
  }

  override info(): Promise<RemoteInfo> {
    return this.#call({ op: "info" }, () => this.#inner?.info() ?? Promise.resolve(STUB_INFO));
  }

  override session(): Promise<number> {
    return this.#call({ op: "session" }, () => this.#inner?.session() ?? Promise.resolve(1));
  }

  override request(
    op: string,
    json: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<Reply> {
    return this.#call(
      { op, json },
      () => this.#inner?.request(op, json, options) ?? Promise.reject(new Error("no daemon")),
    );
  }

  #call<T>(call: ConnectionCall, through: () => Promise<T>): Promise<T> {
    const error = this.#failWhen(call);
    return error === undefined ? through() : Promise.reject(error);
  }

  override close(): void {
    this.#inner?.close();
  }

  override kill(id: number, session: number): void {
    this.#inner?.kill(id, session);
  }
}

/**
 * The local daemon until an exec carrying `marker`; from then on a room whose
 * host key no longer matches: every start fails with `failure`, seen by the
 * runner's own trust record (a `DaemonConnection`'s), as in production.
 */
export class RebuiltRoom extends DaemonConnection {
  readonly #local: Connection;
  readonly #marker: string;
  #rebuilt = false;

  constructor(local: Connection, marker: string, failure: () => Error) {
    super(() => Promise.reject(failure()));
    this.#local = local;
    this.#marker = marker;
  }

  override info(): Promise<RemoteInfo> {
    return this.#rebuilt ? super.info() : this.#local.info();
  }

  override session(): Promise<number> {
    return this.#rebuilt ? super.session() : this.#local.session();
  }

  override request(
    op: string,
    json: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<Reply> {
    if (op === "exec" && JSON.stringify(json).includes(this.#marker)) {
      this.#rebuilt = true;
    }
    return this.#rebuilt
      ? super.request(op, json, options)
      : this.#local.request(op, json, options);
  }

  override close(): void {
    this.#local.close();
    super.close();
  }

  override kill(id: number, session: number): void {
    if (this.#rebuilt) {
      super.kill(id, session);
    } else {
      this.#local.kill(id, session);
    }
  }
}
