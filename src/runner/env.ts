// A job's execution environment (design §5.2, DEC-054, amended DEC-055):
// pi-env's remote environment over the job's daemon connection, observed by
// the room tier's `ObservedConnection`, so a lost connection is seen by type,
// where it is still typed, before pi-durable turns it into tool-result text
// (pause.ts fills the observer). The connection itself is built in
// room/connection.ts from the configured facts (EX-3, EX-4, EX-5).

import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { type ConnectionObserver, ObservedConnection } from "../room/connection.ts";

export interface JobEnvOptions {
  jobId: string;
  /** The repo's clone in the room (`guest_path`). */
  cwd: string;
  /** The daemon connection; production's is `daemonConnection`. */
  connection: Connection;
  observer: ConnectionObserver;
}

/** The environment id of job `jobId`'s env and of its room shell. */
export const jobEnvId = (jobId: string): string => `pi-env:job-${jobId}`;

/** Job `jobId`'s environment: `connection` behind an `ObservedConnection` (EX-7). */
export function jobEnv(options: JobEnvOptions): RemoteExecutionEnv {
  return new RemoteExecutionEnv({
    connection: new ObservedConnection(options.connection, options.observer),
    id: jobEnvId(options.jobId),
    cwd: options.cwd,
  });
}
