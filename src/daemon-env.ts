// The daemon's environment (design §4.3–§4.5, DEC-079–DEC-081): the one place
// an execution profile becomes where the agent's tools run, their cwd, and the
// project context read at startup. Host: this machine, as before. Room: one
// lazy pi-env daemon connection into the room user's home for the daemon's
// life, shared by every conversation, its faults worded once at the connection
// seam. A fault or trust decision belongs to that one connection, never to a
// conversation (DEC-106): a fault one conversation's tool call sees is the
// daemon's, logged once.
//
// A profile is also where a conversation's identity enters its tools (DEC-020):
// the hook resolves the conversation against the index and passes its `SATAN_*`
// variables along, the host as the node env's `shellEnv`.

import { existsSync } from "node:fs";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RemoteError } from "@earendil-works/pi-env";
import type { Execution, Profile } from "./config.ts";
import { contextOf, conversationVars } from "./conversation-context.ts";
import { messageOf } from "./message-of.ts";
import {
  type ContextSource,
  gitRootDirs,
  nodeSourceReader,
  readSources,
} from "./project-context.ts";
import {
  type ConnectionObserver,
  type DaemonHelpers,
  daemonConnection,
  directLaunch,
  observedEnv,
  type Reword,
  type RoomFault,
} from "./room/connection.ts";
import { ChannelFailed, ChannelUnavailable, type RoomShell, roomShell } from "./room/shell.ts";
import { type ReadFailure, roomSourceReader } from "./room/source-reader.ts";
import type { SessionOptions } from "./session.ts";

export interface DaemonEnv {
  env: SessionOptions["env"];
  /** The agent's cwd: the launch dir (host) or the room user's home (room). */
  cwd: string;
  /** Project context sources, read once at startup; [] when the room is unreadable. */
  readContext: () => Promise<ContextSource[]>;
  close: () => void;
}

type HostExecution = Extract<Execution, { profile: "host" }>;
type RoomExecution = Extract<Execution, { profile: "room" }>;

const FAULT_WORDS: Record<RoomFault, string> = {
  unavailable: "room unavailable",
  untrusted: "room host key untrusted",
};

/** The one wording of a room fault (design §4.4), for the tool and the log alike. */
const faultText = (fault: RoomFault, message: string): string =>
  `${FAULT_WORDS[fault]}: ${message}`;

/** The daemon's reword: the fault named, the error's type and fields kept. */
const reword: Reword = (fault, error) =>
  new RemoteError({ ...error.fields, message: faultText(fault, error.message) });

/** Logs each room fault the tool path sees; a trust failure every time. */
const faultLog = (log: (text: string) => void): ConnectionObserver => ({
  lost: (_failure, error): Promise<void> => {
    log(faultText("unavailable", messageOf(error)));
    return Promise.resolve();
  },
  untrusted: (_failure, trust): void => {
    log(faultText("untrusted", trust.message));
  },
});

/** The room fault a startup read failed with, or undefined for any other error. */
function faultOf(error: unknown): RoomFault | undefined {
  if (error instanceof ChannelUnavailable) {
    return "unavailable";
  }
  if (error instanceof ChannelFailed && error.reason === "host_key") {
    return "untrusted";
  }
  return undefined;
}

/** A read failure as a log reads it: the reason, then the exit code and stderr when known. */
function describeFailure(failure: ReadFailure): string {
  if (failure.reason !== "error") {
    return failure.reason;
  }
  const code = failure.code === undefined ? "" : ` (exit ${String(failure.code)})`;
  const stderr = failure.stderr?.trim() ?? "";
  return `error${code}${stderr === "" ? "" : `: ${stderr}`}`;
}

/**
 * Project context from the room user's `home` only, over `shell` (DEC-080):
 * the home is not a git repo, so no root walk. A failed read is logged and
 * skipped; a down or untrusted room is logged and yields []. Every exec is
 * bounded by the reader's limits.
 */
export async function readRoomContext(
  shell: RoomShell,
  home: string,
  log: (text: string) => void,
): Promise<ContextSource[]> {
  const reader = roomSourceReader(shell, new AbortController().signal, (source, failure) => {
    log(`project context: ${source}: ${describeFailure(failure)}`);
  });
  try {
    return await readSources(home, [home], reader);
  } catch (error) {
    const fault = faultOf(error);
    if (fault === undefined) {
      throw error;
    }
    log(faultText(fault, messageOf(error)));
    return [];
  }
}

/**
 * One conversation's environment: its cwd and the variables its tools run with.
 * The agent's cwd wins, the daemon's is the only fallback (DEC-022); the index
 * read is the one `contextOf` makes, and a failed read is the caller's error,
 * never an empty context.
 */
async function conversationEnv(
  profile: Profile,
  defaultCwd: string,
  target: EnvTarget,
): Promise<{ cwd: string; vars: Record<string, string> }> {
  const cwd = target.cwd ?? defaultCwd;
  const conversation = await contextOf(target.read, target.conversationId);
  return { cwd, vars: conversationVars(profile, cwd, conversation) };
}

const hostEnv = (execution: HostExecution): DaemonEnv => ({
  env: async (target): Promise<ExecutionEnv> => {
    const { cwd, vars } = await conversationEnv(execution.profile, execution.cwd, target);
    return new NodeExecutionEnv({ cwd, shellEnv: vars });
  },
  cwd: execution.cwd,
  readContext: () => readSources(execution.cwd, gitRootDirs(execution.cwd), nodeSourceReader),
  close: () => undefined,
});

function roomEnv(
  { room, home }: RoomExecution,
  log: (text: string) => void,
  helpers?: DaemonHelpers,
): DaemonEnv {
  // pi-env started directly in the room user's home (DEC-081). Lazy: a failed
  // start fails that call, the next call retries. Both paths below wrap this
  // DaemonConnection directly, never an ObservedConnection: the trust check
  // reads its immediate inner connection, so a nested wrapper would report a
  // host-key refusal as a loss.
  const connection = daemonConnection(room, directLaunch, helpers);
  const observer = faultLog(log);
  return {
    env: (state) =>
      observedEnv(connection, observer, {
        id: "pi-env:daemon-room",
        cwd: state.cwd ?? home,
        reword,
      }),
    cwd: home,
    // The bare connection: roomShell observes it itself (RV-035 F-4).
    readContext: () =>
      readRoomContext(
        roomShell(connection, { id: "pi-env:daemon-room-context", cwd: home }),
        home,
        log,
      ),
    close: (): void => {
      connection.close();
    },
  };
}

/** `execution` as the daemon's environment; `helpers` are pi-env's start steps (a test seam). */
export const daemonEnv = (
  execution: Execution,
  log: (text: string) => void,
  helpers?: DaemonHelpers,
): DaemonEnv =>
  execution.profile === "host" ? hostEnv(execution) : roomEnv(execution, log, helpers);

/**
 * Refuses startup when the room's gateway client socket is set but absent
 * (design §4.4). Presence only: a stale socket or a failing listener reaches
 * the model call as the provider's connection error.
 */
export function requireGatewaySocket(
  execution: Execution,
  exists: (path: string) => boolean = existsSync,
): void {
  const socket = execution.profile === "room" ? execution.gatewaySocket : undefined;
  if (socket !== undefined && !exists(socket)) {
    throw new Error(`gateway socket missing: ${socket} (llm-gateway client listener)`);
  }
}
