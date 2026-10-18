// Job ids: `pj-<ULID>` (design §5.3). A ULID is 48 bits of epoch ms then 80
// random bits, in Crockford base32, so ids sort lexically in creation order.
// Pure: the clock and the random source are the caller's.

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;
const MAX_TIME = 2 ** 48 - 1;

/** `size` random bytes. */
export type RandomSource = (size: number) => Uint8Array;

/** Mints the id of a job submitted at `now`. */
export type JobIdFactory = (now: number) => string;

/** The low `length` × 5 bits of `value`, most significant first. */
function base32(value: bigint, length: number): string {
  let text = "";
  let rest = value;
  for (let index = 0; index < length; index++) {
    text = CROCKFORD.charAt(Number(rest & 31n)) + text;
    rest >>= 5n;
  }
  return text;
}

/** The job id for time `now` (epoch ms) and randomness drawn from `random`. */
export function newJobId(now: number, random: RandomSource): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) {
    throw new Error(`job id time must be an integer in [0, 2^48): ${String(now)}`);
  }
  const entropy = random(RANDOM_BYTES);
  if (entropy.length < RANDOM_BYTES) {
    throw new Error(`job id needs ${String(RANDOM_BYTES)} random bytes`);
  }
  let bits = 0n;
  for (const byte of entropy.subarray(0, RANDOM_BYTES)) {
    bits = (bits << 8n) | BigInt(byte);
  }
  return `pj-${base32(BigInt(now), TIME_CHARS)}${base32(bits, RANDOM_CHARS)}`;
}

/** Ids from the system's cryptographic random source. */
export const systemJobIds: JobIdFactory = (now) => newJobId(now, randomBytes);
