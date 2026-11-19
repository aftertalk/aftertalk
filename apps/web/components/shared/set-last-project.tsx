'use client';

import { useEffect } from 'react';

// Same name as LAST_PROJECT_COOKIE in lib/landing.ts (server-only, so not importable here).
const COOKIE = 'atLastProject';

/** Remembers the project being viewed, so `/` opens it next time (item 18b). */
export function SetLastProject({ projectId }: { projectId: string }) {
  useEffect(() => {
    document.cookie = `${COOKIE}=${encodeURIComponent(projectId)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  }, [projectId]);
  return null;
}
