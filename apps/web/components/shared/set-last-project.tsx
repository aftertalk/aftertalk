'use client';

import { useEffect } from 'react';

import { LAST_ORG_COOKIE, LAST_PROJECT_COOKIE } from '@/lib/last-used-cookies';

const YEAR = 60 * 60 * 24 * 365;

/** Remembers the project (and its organisation) being viewed, so `/` opens it next time (item 18b). */
export function SetLastProject({ projectId, organizationId }: { projectId: string; organizationId: string }) {
  useEffect(() => {
    document.cookie = `${LAST_PROJECT_COOKIE}=${encodeURIComponent(projectId)}; path=/; max-age=${YEAR}; SameSite=Lax`;
    document.cookie = `${LAST_ORG_COOKIE}=${encodeURIComponent(organizationId)}; path=/; max-age=${YEAR}; SameSite=Lax`;
  }, [projectId, organizationId]);
  return null;
}
