// The wrapper every user-facing server action runs in. Kept apart from result.ts, which client
// components import for its types and error classes: this file reads translations on the server.
import 'server-only';

import { unstable_rethrow } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { i18n } from '@/i18n/constants';

import { type ActionResult, BackendError, ForbiddenError, NotFoundError, TwoFactorRequiredError } from './result';

/**
 * Runs a server-action body and converts an expected failure (a {@link BackendError} below 500)
 * into a returned {@link ActionResult}. Anything else stays thrown, so it's logged server-side and
 * the client shows its own translated generic message. Framework control-flow signals
 * (redirect / notFound) are re-thrown via `unstable_rethrow` so navigation still works.
 *
 * The access errors of lib/access.ts carry fixed English text for logs and route handlers; here
 * they become a sentence in the reader's language, because the form shows what this returns.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    unstable_rethrow(e);
    if (!(e instanceof BackendError) || e.status >= 500) throw e;
    const key =
      e instanceof TwoFactorRequiredError
        ? i18n.errors.twoFactorRequired
        : e instanceof ForbiddenError && e.message === 'Forbidden'
          ? i18n.errors.forbidden
          : e instanceof NotFoundError && e.message === 'Not found'
            ? i18n.errors.notFound
            : null;
    return { ok: false, error: key ? (await getTranslations())(key) : e.message };
  }
}
