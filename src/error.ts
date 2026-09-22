export type ErrorCode =
  | "CLI_USAGE"
  | "CONFIG"
  | "SOURCE_IO"
  | "IMPORT_SYNTAX"
  | "IMPORT_CYCLE"
  | "CACHE_UNTRUSTED"
  | "CACHE_CORRUPT"
  | "CACHE_IO"
  | "CODEC"
  | "COMPILER_API"
  | "COMPILER_REJECTED"
  | "UNSTABLE_INPUTS";

export class PocError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PocError";
    this.code = code;
    this.details = details;
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function errorJson(value: unknown): Readonly<Record<string, unknown>> {
  if (value instanceof PocError) {
    return {
      code: value.code,
      message: value.message,
      details: value.details,
    };
  }
  const error = asError(value);
  return { code: "INTERNAL", message: error.message };
}
