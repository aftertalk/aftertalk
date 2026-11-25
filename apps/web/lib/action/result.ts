/**
 * Discriminated result returned by user-facing server actions.
 *
 * Server Actions mask thrown Error messages in production — the client only receives a
 * generic message + digest, never the real text. Returning the message as a value keeps it
 * intact across the server→client boundary, so client components can display it (or branch
 * on it) reliably.
 */
export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

/** Upload outcome: the new call's id. */
export type UploadResult = { ok: true; data: { callId: string } } | { ok: false; error: string };

/**
 * An expected, user-actionable failure with an HTTP-like status. The name is kept from the cloud,
 * where it wrapped the backend's 4xx answers (#37): components check `instanceof BackendError`.
 */
export class BackendError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/** The user has a role in the project or organisation, but below the one the action needs. */
export class ForbiddenError extends BackendError {
  constructor(message = 'Forbidden') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

/** The organisation requires 2FA and the user has not set it up (#64). */
export class TwoFactorRequiredError extends ForbiddenError {
  constructor() {
    super('Two-factor authentication is required in this organization');
    this.name = 'TwoFactorRequiredError';
  }
}

/** No role at all, or the thing does not exist: both answer "not found", so ids leak nothing. */
export class NotFoundError extends BackendError {
  constructor(message = 'Not found') {
    super(404, message);
    this.name = 'NotFoundError';
  }
}
