// The runner's model catalog (design §5.1, §5.3): the gateway provider alone,
// no built-in. The catalog is the file `~/flakes` renders for the jails; the
// key is a systemd credential, read once at start and held only in the
// provider's closure (DEC-049). Every failure is a StartRefused (I13); no
// message carries the key.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { gatewayProvider, parseGatewayCatalog } from "../models.ts";
import type { GatewayConfig } from "./config.ts";
import { type Env, messageOf, requiredEnv, StartRefused } from "./errors.ts";

/** The text of `path`, or a refusal naming `what` and the path. */
async function readRequired(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new StartRefused(`${what} ${path}: ${messageOf(error)}`, { cause: error });
  }
}

/** The key in credential file `path`: its text less one trailing newline. */
async function readKey(path: string): Promise<string> {
  const key = (await readRequired(path, "gateway credential")).replace(/\n$/, "");
  if (key === "") {
    throw new StartRefused(`gateway credential ${path}: file is empty`);
  }
  return key;
}

/** A catalog holding the gateway provider alone, keyed by the credential `gateway` names. */
export async function loadGatewayModels(gateway: GatewayConfig, env: Env): Promise<Models> {
  const key = await readKey(join(requiredEnv(env, "CREDENTIALS_DIRECTORY"), gateway.credential));
  const text = await readRequired(gateway.catalog, "gateway catalog");
  let provider;
  try {
    provider = gatewayProvider(parseGatewayCatalog(text), key);
  } catch (error) {
    throw new StartRefused(`gateway catalog ${gateway.catalog}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const models = createModels();
  models.setProvider(provider);
  return models;
}
