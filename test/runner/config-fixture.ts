// Inline runner config shared by the runner tests: fake paths, no prod data.

import { parseRunnerConfig, type RunnerConfig } from "../../src/runner/config.ts";

export const HOME = "/home/test";

export const EXAMPLE_TOML = `
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

[defaults]
model = "gateway/test-model"
thinking_level = "low"
cost_usd = 1.5

[mode.fix]
prompt = "Fix mode: keep the change small."

[tag."cheap+code"]
model = "gateway/cheap"
tokens = 500_000

[repo.satan]
path = "~/dev/satan"
guest_path = "/work/repos/satan"
default_branch = "main"
prompt = "Repo note."

[door]
slot = "f"
quarantine = "~/state/collect/f.git"
ssh_config = "~/.ssh/config"
identity = "~/.ssh/id"
known_hosts = "~/.ssh/known_hosts"
`;

/** The example with `from` replaced by `to`; fails loudly if `from` is absent. */
export function variant(from: string, to: string): string {
  if (!EXAMPLE_TOML.includes(from)) {
    throw new Error(`fixture lacks ${from}`);
  }
  return EXAMPLE_TOML.replace(from, to);
}

export const exampleConfig = (): RunnerConfig => parseRunnerConfig(EXAMPLE_TOML, HOME);
