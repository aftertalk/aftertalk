/**
 * Cookie holding the last non-docs page the visitor was on, so the docs can send them back where
 * they came from.
 *
 * A cookie rather than sessionStorage because the docs sidebar is rendered on the server — nothing
 * in it runs in the browser — so the destination has to be readable while rendering.
 */
export const LAST_APP_PATH_COOKIE = 'atLastPath';
