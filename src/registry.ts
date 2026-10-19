// The pi-durable registry both binaries build from their extensions.

import { createRegistry, type Extension, type Registry } from "@earendil-works/pi-durable";

/** A registry with `extensions` installed, in order. */
export function registryOf(extensions: readonly Extension[]): Registry {
  const registry = createRegistry();
  for (const extension of extensions) {
    registry.install(extension);
  }
  return registry;
}
