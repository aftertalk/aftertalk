// Input checks shared by the server actions. A server action is a public endpoint: its arguments
// come from the browser as untyped JSON, whatever the TypeScript signature says.
import 'server-only';

import { getTranslations } from 'next-intl/server';

import { i18n } from '@/i18n/constants';
import { isUuid } from '@/lib/utils/uuid';

import { BackendError, NotFoundError } from './result';

/** An id that is not a UUID names nothing: answer "not found" before it reaches a query. */
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new NotFoundError();
  return value.toLowerCase();
}

/** A 400 with a translated sentence the form can show. */
export async function invalid(key: string, values?: Record<string, string | number>): Promise<never> {
  const t = await getTranslations();
  throw new BackendError(400, t(key, values));
}

/** A 409 with a translated sentence. */
export async function conflict(key: string, values?: Record<string, string | number>): Promise<never> {
  const t = await getTranslations();
  throw new BackendError(409, t(key, values));
}

/** Trimmed text of 1..max characters. */
export async function requiredText(value: unknown, max: number): Promise<string> {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > max) await invalid(i18n.errors.textLength, { max });
  return text;
}

/** Trimmed text of at most `max` characters; empty, null and undefined become null. */
export async function optionalText(value: unknown, max: number): Promise<string | null> {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') await invalid(i18n.errors.invalidInput);
  const text = (value as string).trim();
  if (text.length > max) await invalid(i18n.errors.textLength, { max });
  return text.length === 0 ? null : text;
}

export function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Postgres unique violation, for "this name is taken" answers. */
export function isUniqueViolation(e: unknown): boolean {
  const code =
    (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
}

/** Escapes `%`, `_` and `\` so user text is matched literally by LIKE. */
export const likeLiteral = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
