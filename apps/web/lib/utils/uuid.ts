// Route ids are UUIDs. Checking them before they reach a backend path keeps a crafted URL such as
// /organization/..%2Fadmin%2Fusers from turning into a request to a different backend endpoint.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
