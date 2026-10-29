// The bookmark backup's node shapes (SL-008 design sec-2 "Validation"): the one
// fail-closed check the projection reads behind. Schema only in this phase;
// PHASE-04 adds the source (file choice, decoding, errors) here.

import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

/** A Firefox bookmark guid: exactly 12 of A-Z a-z 0-9 _ -. */
export const GUID = /^[A-Za-z0-9_-]{12}$/;

const CONTAINER = "text/x-moz-place-container";
const PLACE = "text/x-moz-place";
const SEPARATOR = "text/x-moz-place-separator";

// The Backup* types are hand-written rather than Static derivations: `Static`
// of the cyclic Ref resolves `children` to `unknown[]` (and `any[]` one level
// down), so it cannot tie the recursion to the schema.

/** One line of a places tree that holds nothing. */
export interface BackupSeparator {
  readonly type: typeof SEPARATOR;
}

/** One bookmark: the fields the projection reads, and nothing else. */
export interface BackupPlace {
  readonly type: typeof PLACE;
  readonly guid: string;
  readonly title?: string;
  readonly uri: string;
  readonly dateAdded?: number;
  readonly tags?: string;
}

/** A folder: the fields the projection reads, and nothing else. */
export interface BackupContainer {
  readonly type: typeof CONTAINER;
  readonly title?: string;
  readonly children?: readonly BackupNode[];
  readonly root?: string;
}

/** Any node of a places tree. */
export type BackupNode = BackupContainer | BackupPlace | BackupSeparator;

const ContainerSchema = Type.Object({
  type: Type.Literal(CONTAINER),
  title: Type.Optional(Type.String()),
  children: Type.Optional(Type.Array(Type.Ref("Node"))),
  root: Type.Optional(Type.String()),
});

const PlaceSchema = Type.Object({
  type: Type.Literal(PLACE),
  guid: Type.String({ pattern: GUID.source }),
  title: Type.Optional(Type.String()),
  uri: Type.String(),
  dateAdded: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.String()),
});

const SeparatorSchema = Type.Object({ type: Type.Literal(SEPARATOR) });

/**
 * A places tree rooted at a container (Firefox's `placesRoot`): extra fields are
 * allowed on every node kind, and one bad node anywhere fails the whole check.
 */
export const BackupTreeSchema = Type.Cyclic(
  {
    Node: Type.Union([ContainerSchema, PlaceSchema, SeparatorSchema]),
    Container: ContainerSchema,
  },
  "Container",
);

/** Whether `value` is a places tree the projection may read. */
export function isBackupTree(value: unknown): value is BackupContainer {
  return Value.Check(BackupTreeSchema, value);
}
