// Rules for provider connections shared by the actions (items 37d, 37f).
import 'server-only';

import { env } from '@/env';

/** Paths a base URL must not end in: every caller appends only the resource (Base URLs section). */
const RESOURCE_PATHS = ['/audio/transcriptions', '/chat/completions', '/models', '/diarize', '/media/input'];

export type BaseUrlProblem = 'invalid' | 'resource_path' | 'host_not_allowed';

/**
 * `http` or `https`, no credentials, query or fragment, trailing slash removed, host in
 * PROVIDER_HOST_ALLOWLIST when that is set.
 */
export function cleanBaseUrl(raw: unknown): { url: string } | { problem: BaseUrlProblem } {
  if (typeof raw !== 'string' || raw.length > 500) return { problem: 'invalid' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { problem: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: 'invalid' };
  if (url.username || url.password || url.search || url.hash || !url.hostname) return { problem: 'invalid' };
  const allow = env.PROVIDER_HOST_ALLOWLIST;
  if (allow.length > 0 && !allow.includes(url.hostname.toLowerCase())) return { problem: 'host_not_allowed' };
  const path = url.pathname.replace(/\/+$/, '');
  if (RESOURCE_PATHS.some((resource) => path.toLowerCase().endsWith(resource))) return { problem: 'resource_path' };
  return { url: `${url.origin}${path}` };
}

const MAX_MODELS = 500;
const MAX_BODY = 1024 * 1024;

/**
 * Model names from `{base_url}/models` (#67). Web sends this request itself, with the decrypted key,
 * a 5-second timeout and redirects not followed. Any failure gives an empty list, and the model
 * field stays a plain text field. Nothing of the response but the ids is returned.
 */
export async function fetchModelNames(baseUrl: string, apiKey: string | null): Promise<string[]> {
  if ('problem' in cleanBaseUrl(baseUrl)) return [];
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (response.status !== 200 || !response.body) return [];
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel();
        return [];
      }
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: unknown };
    if (!Array.isArray(parsed?.data)) return [];
    const names = parsed.data
      .map((m) => (m as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200);
    return [...new Set(names)].sort().slice(0, MAX_MODELS);
  } catch {
    return [];
  }
}
