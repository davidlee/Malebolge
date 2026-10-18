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
