// The room's shell (design §5.2 "Env uses outside `running`"): argument
// vectors run in the room's clone through a job's daemon connection, for the
// `preparing` checks and switch and the clean after collect. Its observer
// only counts: a lost connection makes the step ChannelUnavailable and never
// marks a pause (EX-8). Only the running job's tools pause (pause.ts).

import { withAbortSignal } from "@earendil-works/chord/context";
import type { Connection } from "@earendil-works/pi-env";
import { context } from "../context.ts";
import { type HostKeyFailure, jobEnv } from "./env.ts";
import { ChannelFailed, ChannelUnavailable, type RoomShell } from "./room.ts";

/**
 * A shell in the room's clone `cwd` over the job's daemon `connection`. The
 * environment turns a lost connection into an exec failure; its connection
 * reports the loss by type first, which is what makes it ChannelUnavailable.
 * A loss whose start failed trust is ChannelFailed `host_key` instead: never
 * retried. Counting only: nothing here marks a pause (EX-8).
 */
export function roomShell(connection: Connection, jobId: string, cwd: string): RoomShell {
  let losses = 0;
  const untrusted: HostKeyFailure[] = [];
  const env = jobEnv({
    jobId,
    cwd,
    connection,
    observer: {
      lost: () => {
        losses++;
        return Promise.resolve();
      },
      untrusted: (_failure, trust) => {
        untrusted.push(trust);
      },
    },
  });
  return async (argv, signal, at) => {
    const before = losses;
    const trustedBefore = untrusted.length;
    const output = { stdout: "", stderr: "" };
    const result = await env.exec(
      argv,
      {
        ...(at === undefined ? {} : { cwd: at }),
        onOutput: (text, _context, info) => {
          output[info.stream] += text;
        },
      },
      withAbortSignal(signal, context),
    );
    if (result.ok) {
      return { code: result.value.exitCode, ...output };
    }
    const message = `${argv.join(" ")}: ${result.error.message}`;
    const trust = untrusted.at(trustedBefore);
    if (trust !== undefined) {
      throw new ChannelFailed(message, { cause: trust, reason: "host_key" });
    }
    throw losses > before
      ? new ChannelUnavailable(message, { cause: result.error })
      : new ChannelFailed(message, { cause: result.error });
  };
}
