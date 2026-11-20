// Stands in for next/headers in tests (mapped in jest.config.ts). One cookie jar per test file plays
// the browser: Better Auth's nextCookies plugin writes the session cookie into it on sign-in, and
// headers() sends it back, so server actions see a real session.
const jar = new Map<string, string>();
let extraHeaders: Record<string, string> = {};

type CookieOptions = { maxAge?: number; expires?: Date };

export const testCookies = {
  clear() {
    jar.clear();
    extraHeaders = {};
  },
  /** Swaps the whole jar, to act as another browser. */
  snapshot: () => new Map(jar),
  restore(saved: Map<string, string>) {
    jar.clear();
    for (const [k, v] of saved) jar.set(k, v);
  },
  setHeader(name: string, value: string) {
    extraHeaders[name] = value;
  },
};

export async function headers(): Promise<Headers> {
  const h = new Headers(extraHeaders);
  if (jar.size > 0) {
    h.set('cookie', [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '));
  }
  return h;
}

export async function cookies() {
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string, opts?: CookieOptions) => {
      const expired = opts?.maxAge === 0 || (opts?.expires && opts.expires.getTime() <= Date.now());
      if (expired || value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => jar.delete(name),
  };
}

export async function draftMode() {
  return { isEnabled: false, enable() {}, disable() {} };
}
