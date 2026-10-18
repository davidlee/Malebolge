// The error codes of the control socket (design §5.2). A RunnerError carries
// one; anything else thrown is a bug, not a refusal.

export const ERROR_CODES = [
  "invalid_request",
  "unknown_job",
  "invalid_transition",
  "base_ref_invalid",
  "ceiling_above_maximum",
  "runner_disabled",
  "receipt_mismatch",
  // Internal to collection (I7); never an answer on the socket.
  "reviewed_oid_mismatch",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class RunnerError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunnerError";
    this.code = code;
  }
}

export const isRunnerError = (value: unknown): value is RunnerError => value instanceof RunnerError;

/** The runner will not start: its config, files or socket are not as they must be (I13). */
export class StartRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StartRefused";
  }
}
