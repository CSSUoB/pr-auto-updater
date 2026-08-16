/**
 * JavaScript allows any value to be thrown, so a caught value is only typed as
 * `unknown`. These messages are used purely for logging, so fall back to the
 * value's own string form rather than discarding it.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
