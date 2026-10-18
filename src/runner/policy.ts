// The policy ladder (design §5.2, DEC-056). Pure: config and job fields in,
// the resolved policy out, stored as JSON in `jobs.policy`. Low → high:
// built-in (ceilings = maxima) → [defaults] → [mode.m] → tag rule → [repo.r]
// → submit ceilings. Config ceilings are clamped to the maxima; a submit
// ceiling above its maximum is refused, never clamped.

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { optionalString, optionalStringArray, requireString, setDefined } from "../fields.ts";
import type { JsonRecord } from "../json.ts";
import {
  CEILING_KEYS,
  type Ceilings,
  ceilingsFrom,
  isThinkingLevel,
  type PolicyLayer,
  readCeilings,
  type RunnerConfig,
} from "./config.ts";
import { RunnerError } from "./errors.ts";

/** The job fields the ladder reads. */
export interface PolicyJob {
  mode: string;
  tags: readonly string[];
  repo: string;
  /** Submit ceilings; each may only lower its maximum. */
  ceilings?: Partial<Ceilings>;
}

export interface ResolvedPolicy {
  model: string;
  thinkingLevel?: ThinkingLevel;
  ceilings: Ceilings;
  /** Mode fragment, then repo fragment; those the config sets. */
  promptFragments: string[];
}

/** The entry `name` of `entries`; `invalid_request` if the config lacks it. */
export function configEntry<T>(entries: ReadonlyMap<string, T>, kind: string, name: string): T {
  const entry = entries.get(name);
  if (entry === undefined) {
    throw new RunnerError("invalid_request", `unknown ${kind} ${JSON.stringify(name)}`);
  }
  return entry;
}

/**
 * The tag rule for `tags` (ported from the Go runner's `pickTagRule`): the
 * sorted tags joined with `+`; failing that, the first single tag in sorted
 * order that has a rule; failing that, none.
 */
export function pickTagRule(
  rules: ReadonlyMap<string, PolicyLayer>,
  tags: readonly string[],
): PolicyLayer | undefined {
  const sorted = [...tags].sort();
  const key = [sorted.join("+"), ...sorted].find((name) => rules.has(name));
  return key === undefined ? undefined : rules.get(key);
}

/** Refuses with `ceiling_above_maximum` any ceiling above its maximum. */
export function checkCeilingsWithinMaxima(ceilings: Partial<Ceilings>, maxima: Ceilings): void {
  const over = CEILING_KEYS.find((key) => (ceilings[key] ?? 0) > maxima[key]);
  if (over !== undefined) {
    throw new RunnerError(
      "ceiling_above_maximum",
      `${over} ${String(ceilings[over])} is above the maximum ${String(maxima[over])}`,
    );
  }
}

const clamp = (ceilings: Ceilings, maxima: Ceilings): Ceilings =>
  ceilingsFrom((key) => Math.min(ceilings[key], maxima[key]));

/** `policy` with the keys `layer` sets laid over it. */
const overlay = (policy: ResolvedPolicy, layer: PolicyLayer): ResolvedPolicy =>
  setDefined<ResolvedPolicy>(
    { ...policy, ceilings: { ...policy.ceilings, ...layer.ceilings } },
    { model: layer.model, thinkingLevel: layer.thinkingLevel },
  );

/** The resolved policy for `job` under `config`. */
export function resolvePolicy(config: RunnerConfig, job: PolicyJob): ResolvedPolicy {
  const mode = configEntry(config.modes, "mode", job.mode);
  const repo = configEntry(config.repos, "repo", job.repo);
  const maxima = config.maxima.ceilings;
  const layers = [config.defaults, mode, pickTagRule(config.tags, job.tags), repo];
  const builtIn: ResolvedPolicy = {
    model: config.defaults.model,
    ceilings: maxima,
    promptFragments: [mode.prompt, repo.prompt].filter((text) => text !== undefined),
  };
  let configured = builtIn;
  for (const layer of layers) {
    configured = layer === undefined ? configured : overlay(configured, layer);
  }
  const submit = job.ceilings ?? {};
  checkCeilingsWithinMaxima(submit, maxima);
  return { ...configured, ceilings: { ...clamp(configured.ceilings, maxima), ...submit } };
}

/**
 * The policy recorded at `preparing` (`jobs.policy`, as `resolvePolicy`
 * wrote it): a restarted run keeps it, whatever the config now says (AS-2).
 * Throws on a record `resolvePolicy` could not have written.
 */
export function recordedPolicy(record: JsonRecord): ResolvedPolicy {
  const raw = record["ceilings"];
  const found = readCeilings(typeof raw === "object" && raw !== null ? { ...raw } : {});
  const ceilings = ceilingsFrom((key) => {
    const value = found[key];
    if (value === undefined) {
      throw new Error(`recorded policy lacks ceiling ${key}`);
    }
    return value;
  });
  const thinkingLevel = optionalString(record, "thinkingLevel");
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
    throw new Error(`recorded policy has thinkingLevel ${JSON.stringify(thinkingLevel)}`);
  }
  return setDefined<ResolvedPolicy>(
    {
      model: requireString(record, "model"),
      ceilings,
      promptFragments: optionalStringArray(record, "promptFragments") ?? [],
    },
    { thinkingLevel },
  );
}
