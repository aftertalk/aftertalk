// Cookie names for "the project and organisation used last" (item 18b). Plain constants, so both the
// browser (components/shared/set-last-project.tsx) and the server (lib/utils/last-used.ts) import them.
export const LAST_PROJECT_COOKIE = 'atLastProject';
export const LAST_ORG_COOKIE = 'atLastOrg';
