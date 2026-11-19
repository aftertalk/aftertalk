import { cookies } from 'next/headers';

// Written by the app shell as the reader moves around (components/shared/app-shell.tsx).
const LAST_PROJECT_COOKIE = 'atLastProject';
const LAST_ORG_COOKIE = 'atLastOrg';

/**
 * Where to send someone who needs "an" organization or project: the one they used last, if they can
 * still see it, else the first. Picking the first outright dropped people into a different
 * organization every time they passed through /setup, /billing or onboarding.
 */
export async function preferLastUsed() {
  const store = await cookies();
  const pick =
    (name: string) =>
    <T extends { id: string }>(items: T[]): T | undefined =>
      items.find((i) => i.id === store.get(name)?.value) ?? items[0];
  return { project: pick(LAST_PROJECT_COOKIE), org: pick(LAST_ORG_COOKIE) };
}
