/**
 * Constrains a user-supplied ?next= redirect target to a same-origin path. Absolute URLs (and
 * protocol-relative forms like //evil.example or /\evil.example) would let a crafted login link
 * send a freshly-authenticated user to an attacker's site. Browsers strip tab/newline from URLs,
 * so "/<TAB>/evil.example" becomes "//evil.example": control characters are rejected outright,
 * and whatever is left must still resolve to our own origin.
 */
export function safeNext(next: string | null, fallback = '/setup'): string {
  if (!next || !/^\/(?![/\\])/.test(next) || /[\u0000-\u001f\u007f]/.test(next)) return fallback;
  const base = 'https://aftertalk.invalid';
  try {
    return new URL(next, base).origin === base ? next : fallback;
  } catch {
    return fallback;
  }
}
