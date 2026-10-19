// Inline runner config shared by the runner tests: fake paths, no prod data.

import { parseRunnerConfig, type RunnerConfig } from "../../src/runner/config.ts";

export const HOME = "/home/test";

/** [mode.fix]'s scope: unbounded, so tests not about scope admit anything. */
export const FIX_SCOPE = 'repos = "*"\nallowed_paths = "*"';

/** Everything but the repos and the door: shared by both door kinds. */
const COMMON_TOML = `
enabled = true
prompt_file = "~/corpus/prompts/patch-agent.md"

[maxima]
model_requests = 200
cost_usd = 2.00
tokens = 2_000_000
active_wall_clock_s = 3600
soft_threshold = 0.8
max_room_wait_s = 21600
max_pending_collection_s = 86400

[gateway]
catalog = "~/gateway/models.json"
credential = "satan-runner"

[defaults]
model = "gateway/test-model"
thinking_level = "low"
cost_usd = 1.5

[mode.fix]
prompt = "Fix mode: keep the change small."
${FIX_SCOPE}

[tag."cheap+code"]
model = "gateway/cheap"
tokens = 500_000
`;

/** A slot-kind config: the live rung. */
export const EXAMPLE_TOML = `${COMMON_TOML}
[repo.satan]
path = "~/dev/satan"
guest_path = "/work/repos/satan"
default_branch = "main"
prompt = "Repo note."

[door]
kind = "slot"
slot = "f"
quarantine = "~/state/collect/f.git"
host = "10.99.0.2"
user = "agent"
ssh_config = "~/.ssh/config"
identity = "~/.ssh/id"
known_hosts = "~/.ssh/known_hosts"
host_key_alias = "pi-env-f"
`;

/**
 * A room-kind config, its values as oubliette SL-006 design sec-6 gives them
 * (at oubliette 73ec574; re-check at SL-006's lock, CHR-016).
 */
export const ROOM_TOML = `${COMMON_TOML}
[repo.satan]
path = "~/dev/satan"
guest_path = "/work/satan"
default_branch = "main"
quarantine = "/var/lib/capsule/collect/assistant/satan.git"
transfer_timeout_s = 600

[door]
kind = "room"
room = "assistant"
user = "agent"
ssh_config = "~/.ssh/room-assistant.conf"
identity = "~/.ssh/runner"
known_hosts = "/var/lib/capsule/room/assistant/known_hosts"
host_key_alias = "room-assistant"
session_path = "/run/current-system/sw/bin/session"
`;

/** `toml` with `from` replaced by `to`; fails loudly if `from` is absent. */
function replaced(toml: string, from: string, to: string): string {
  if (!toml.includes(from)) {
    throw new Error(`fixture lacks ${from}`);
  }
  return toml.replace(from, to);
}

/** The slot example with `from` replaced by `to`. */
export const variant = (from: string, to: string): string => replaced(EXAMPLE_TOML, from, to);

/** The room example with `from` replaced by `to`. */
export const roomVariant = (from: string, to: string): string => replaced(ROOM_TOML, from, to);

/** The slot example with [mode.fix]'s scope lines replaced by `scope`. */
export const scopedConfig = (scope: string): RunnerConfig =>
  parseRunnerConfig(variant(FIX_SCOPE, scope), HOME);

/** Modes under which NEW_JOB (repo satan, paths src/) is no longer admissible. */
export const narrowedModes = (): RunnerConfig["modes"] =>
  scopedConfig('repos = ["satan"]\nallowed_paths = ["docs/"]').modes;

export const exampleConfig = (): RunnerConfig => parseRunnerConfig(EXAMPLE_TOML, HOME);

export const roomConfig = (): RunnerConfig => parseRunnerConfig(ROOM_TOML, HOME);
