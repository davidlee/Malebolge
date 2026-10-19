// The runner's model catalog (design §5.1, §5.3): the shared gateway loader,
// with the key taken from a systemd credential (DEC-049). Every failure is a
// StartRefused (I13); no message carries the key.

import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { loadGatewayModels as loadModels } from "../models.ts";
import type { GatewayConfig } from "./config.ts";
import { type Env, messageOf, requiredEnv, StartRefused } from "./errors.ts";

/** A catalog holding the gateway provider alone, keyed by the credential `gateway` names. */
export async function loadGatewayModels(gateway: GatewayConfig, env: Env): Promise<Models> {
  const keyPath = join(requiredEnv(env, "CREDENTIALS_DIRECTORY"), gateway.credential);
  try {
    return await loadModels(gateway.catalog, keyPath);
  } catch (error) {
    throw error instanceof StartRefused
      ? error
      : new StartRefused(messageOf(error), { cause: error });
  }
}
