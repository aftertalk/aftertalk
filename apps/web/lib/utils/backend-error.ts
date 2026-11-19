import type { ActionResult } from '@/lib/action/result';

/** A failed {@link ActionResult}, re-thrown on the client — its message came back as a value, so it's intact. */
export class ActionError extends Error {}

/**
 * Unwraps a server action's {@link ActionResult}, throwing its error as an {@link ActionError} so
 * call sites keep their try/catch shape and read the message with {@link backendMessage}.
 */
export function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new ActionError(result.error);
  return result.data;
}

/**
 * The server's actionable reason (e.g. member-not-allowed 403) from an error
 * thrown by {@link unwrap}, so the UI can show it instead of a generic "try again". Returns null
 * for anything else — an error thrown inside a server action reaches the client with its message
 * masked in production, so it's never worth showing.
 */
export function backendMessage(e: unknown): string | null {
  return e instanceof ActionError ? e.message || null : null;
}
