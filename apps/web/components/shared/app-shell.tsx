'use client';

import {
  ChevronLeft,
  FileText,
  FolderKanban,
  Home,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Settings,
  SlidersHorizontal,
  Sun,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import { AccountMenu } from '@/components/shared/account-menu';
import { useLocaleSwitch } from '@/components/shared/language-switcher';
import { Wordmark } from '@/components/shared/logo';
import { OrgSwitcher } from '@/components/shared/org-switcher';
import { ProjectSelector } from '@/components/shared/project-selector';
import { SUPPORTED_LOCALES } from '@/i18n/config';
import { authClient } from '@/lib/auth/client';
import { LAST_APP_PATH_COOKIE } from '@/lib/last-app-path';
import type { OrganizationResponse, ProjectResponse } from '@/lib/types';
import { cn } from '@/lib/utils/cn';

/** Session cookie naming the org last worked in, so account settings can link back to it. The account
 *  page reads it by name (a server component can't import values from this client module). */
// Read on the server by lib/utils/last-used.ts (and the account page) to send people back where they were.
const LAST_ORG_COOKIE = 'atLastOrg';
const LAST_PROJECT_COOKIE = 'atLastProject';

export type ShellContext =
  | { kind: 'org'; organizationId: string }
  | { kind: 'project'; projectId: string }
  /** `organizationId`: the org the visitor came from, for the back link (falls back to their first). */
  | { kind: 'account'; organizationId?: string };

interface NavItem {
  href: string;
  label: string;
  icon: typeof Home;
  exact: boolean;
  keepDateParams: boolean;
  /** Sub-sections shown nested under the item while its section is active. */
  children?: { tab: string; label: string }[];
  /** Sub-sections stay in the desktop sidebar only (the page brings its own tabs on small screens). */
  childrenDesktopOnly?: boolean;
}

interface AppShellProps {
  user?: { email?: string; id?: string } | null;
  context: ShellContext;
  projects?: ProjectResponse[];
  organizations?: OrganizationResponse[];
  /** Which one-time setup steps are done; while any is missing, Upload shows the setup steps. */
  uploadSetup?: { categories: boolean; roles: boolean; templates: boolean; providers: boolean };
  /** Server-read collapsed state so the sidebar renders correct on first paint (no flash). */
  initialSidebarCollapsed?: boolean;
  children: React.ReactNode;
}

const ITEM_IDLE =
  'text-muted-foreground hover:bg-foreground/6 hover:text-foreground dark:text-white/55 dark:hover:bg-white/8 dark:hover:text-white';
const ITEM_ACTIVE = 'bg-foreground/8 text-foreground dark:bg-white/12 dark:text-white';

export function AppShell({
  user,
  context,
  projects = [],
  organizations = [],
  uploadSetup,
  initialSidebarCollapsed = false,
  children,
}: AppShellProps) {
  const t = useTranslations('navbar');
  const tRoot = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { resolvedTheme, setTheme } = useTheme();
  const tc = useTranslations('common');
  const { locale, setLocale } = useLocaleSwitch();
  const otherLocale = SUPPORTED_LOCALES.find((l) => l !== locale) ?? SUPPORTED_LOCALES[0];
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(initialSidebarCollapsed);

  const projectId = context.kind === 'project' ? context.projectId : undefined;
  const currentOrgId =
    context.kind === 'org'
      ? context.organizationId
      : context.kind === 'project'
        ? projects.find((p) => p.id === context.projectId)?.organizationId
        : (context.organizationId ?? organizations[0]?.id);

  // Remember the page we are on. A cookie rather than sessionStorage so the server can read it.
  // Session cookie — it describes this visit, not a lasting preference.
  useEffect(() => {
    const query = searchParams.toString();
    const path = query ? `${pathname}?${query}` : pathname;
    // Secure wherever the page itself is; it names an organization or project, so it has no business
    // travelling in clear text. Omitted on plain http so local development still works.
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${LAST_APP_PATH_COOKIE}=${encodeURIComponent(path)}; path=/; SameSite=Lax${secure}`;
    // The org and project being worked in, so pages that belong to neither (account settings)
    // return here. Kept for a year: it is where the reader works, not just this visit.
    const lasting = `; path=/; max-age=31536000; SameSite=Lax${secure}`;
    if (context.kind !== 'account' && currentOrgId) document.cookie = `${LAST_ORG_COOKIE}=${currentOrgId}${lasting}`;
    if (projectId) document.cookie = `${LAST_PROJECT_COOKIE}=${projectId}${lasting}`;
  }, [pathname, searchParams, context.kind, currentOrgId, projectId]);

  // Persisted as a cookie so the server renders the right state on first paint
  // (avoids the sidebar flashing open then closing when the layout re-mounts).
  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `sidebarCollapsed=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  };

  const currentOrg = organizations.find((o) => o.id === currentOrgId);
  const canManageCurrentOrg = currentOrg?.role === 'OWNER' || currentOrg?.role === 'ADMIN';
  // Members can create projects only when the org allows it; owners/admins always can.
  const canCreateProject = !currentOrg || canManageCurrentOrg || currentOrg.allowMemberProjectCreate;
  const orgProjects = currentOrgId ? projects.filter((p) => p.organizationId === currentOrgId) : projects;

  // Home/Calls keep the dashboard date-range filters when switching between them.
  const dateParams = new URLSearchParams();
  const range = searchParams.get('range');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (range) dateParams.set('range', range);
  if (from) dateParams.set('from', from);
  if (to) dateParams.set('to', to);
  const dateQuery = dateParams.toString();

  function navHref(item: NavItem) {
    return item.keepDateParams && dateQuery ? `${item.href}?${dateQuery}` : item.href;
  }

  // The sidebar depends on one thing only: which context we're in.
  let items: NavItem[] = [];
  if (context.kind === 'org') {
    const base = `/organization/${context.organizationId}`;
    items = [{ href: base, label: t('projects'), icon: FolderKanban, exact: true, keepDateParams: false }];
    if (canManageCurrentOrg) {
      items.push(
        { href: `${base}/providers`, label: t('providers'), icon: Plug, exact: false, keepDateParams: false },
        { href: `${base}/settings`, label: t('settings'), icon: Settings, exact: false, keepDateParams: false }
      );
    }
  } else if (context.kind === 'project') {
    const base = `/${context.projectId}`;
    const setupItems = [
      { tab: 'categories', label: t('categories') },
      { tab: 'roles', label: t('channelRoles') },
      { tab: 'templates', label: t('analysisTemplates') },
    ];
    const providersItem = { tab: 'providers', label: tRoot('projectConfig.providers.title') };
    const configItems = [{ tab: 'general', label: tRoot('projectConfig.general.title') }, ...setupItems, providersItem];
    const uploadGated =
      !!uploadSetup &&
      (!uploadSetup.categories || !uploadSetup.roles || !uploadSetup.templates || !uploadSetup.providers);
    items = [
      { href: `${base}/home`, label: t('home'), icon: Home, exact: true, keepDateParams: true },
      { href: `${base}/calls`, label: t('calls'), icon: FileText, exact: false, keepDateParams: true },
      {
        href: `${base}/upload`,
        label: t('upload'),
        icon: Upload,
        exact: false,
        keepDateParams: false,
        children: uploadGated ? [...setupItems, providersItem] : undefined,
      },
      // Task status filters live on the Tasks page itself.
      { href: `${base}/tasks`, label: t('tasks'), icon: ListChecks, exact: false, keepDateParams: false },
      {
        href: `${base}/configure`,
        label: t('configure'),
        icon: SlidersHorizontal,
        exact: false,
        keepDateParams: false,
        children: configItems,
        childrenDesktopOnly: true,
      },
    ];
  } else {
    items = [{ href: '/account', label: t('accountSettings'), icon: UserRound, exact: true, keepDateParams: false }];
  }

  // Account settings belong to no org: link back to the one they were opened from. (A project reaches its
  // org's project list through the project switcher.)
  const backLink =
    context.kind === 'account' && currentOrgId
      ? { href: `/organization/${currentOrgId}`, label: t('backToOrganization') }
      : null;

  const handleLogout = async () => {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  };

  const isItemActive = (item: NavItem) => (item.exact ? pathname === item.href : pathname.startsWith(item.href));
  const currentTab = searchParams.get('tab');

  const renderNavItems = ({
    rail = false,
    mobile = false,
    onNavigate,
  }: {
    rail?: boolean;
    mobile?: boolean;
    onNavigate?: () => void;
  }) =>
    items.map((item) => {
      const Icon = item.icon;
      const showChildren = !rail && !(mobile && item.childrenDesktopOnly);
      const subItems = showChildren && item.children && pathname.startsWith(item.href) ? item.children : null;
      return (
        <div key={item.href}>
          <Link
            href={navHref(item)}
            onClick={onNavigate}
            title={rail ? item.label : undefined}
            aria-label={rail ? item.label : undefined}
            className={cn(
              'flex items-center rounded-xl text-sm transition-colors',
              rail ? 'size-9 justify-center' : 'gap-2.5 px-2.5 py-1.5',
              subItems ? 'text-foreground dark:text-white' : isItemActive(item) ? ITEM_ACTIVE : ITEM_IDLE
            )}
          >
            <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            {!rail && <span className="truncate">{item.label}</span>}
          </Link>
          {subItems && (
            <div className="mt-0.5 mb-1 ml-5.5 flex flex-col gap-0.5 border-l border-black/[0.07] pl-3 dark:border-white/10">
              {subItems.map((sub) => {
                const active = (currentTab ?? subItems[0].tab) === sub.tab;
                return (
                  <Link
                    key={sub.tab}
                    href={`${item.href}?tab=${sub.tab}`}
                    onClick={onNavigate}
                    className={cn(
                      'truncate rounded-lg px-2.5 py-1 text-sm transition-colors',
                      active ? ITEM_ACTIVE : ITEM_IDLE
                    )}
                  >
                    {sub.label}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      );
    });

  return (
    <div className="relative min-h-screen bg-[#F4F4F2] lg:flex dark:bg-[#080808]">
      {/* First thing a keyboard reaches: past the sidebar's dozen links, straight to the page. */}
      <a
        href="#content"
        className="bg-background text-foreground ring-ring sr-only z-50 rounded-lg px-4 py-2 text-sm font-medium ring-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t('skipToContent')}
      </a>
      {/* Sidebar (desktop): brand, workspace switchers, nav, and the account at the foot. No top bar. */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden py-5 transition-[width] duration-300 ease-in-out lg:flex',
          collapsed ? 'w-16 items-center px-3.5' : 'w-64 px-3'
        )}
      >
        <Link
          href={currentOrgId ? `/organization/${currentOrgId}` : '/'}
          aria-label="Aftertalk"
          className={cn(
            'text-foreground mb-4 flex h-8 shrink-0 items-center transition-opacity hover:opacity-70',
            collapsed ? 'w-3 justify-start overflow-hidden' : 'px-2.5'
          )}
        >
          {/* Collapsed, the clipped wordmark leaves its first letter as the mark. */}
          <Wordmark className="h-5 w-auto max-w-none shrink-0" />
        </Link>

        {organizations.length > 0 && (
          <div className="mb-4 flex w-full flex-col gap-0.5">
            <OrgSwitcher
              organizations={organizations}
              currentOrgId={currentOrgId}
              variant={collapsed ? 'rail' : 'sidebar'}
            />
            {!collapsed && context.kind === 'project' && orgProjects.length > 0 && (
              <ProjectSelector
                projects={orgProjects}
                currentProjectId={projectId}
                currentOrgId={currentOrgId}
                canCreate={canCreateProject}
                variant="sidebar"
              />
            )}
          </div>
        )}

        <div className="min-h-0 w-full flex-1 overflow-y-auto">
          {backLink && !collapsed && (
            <Link
              href={backLink.href}
              className="text-muted-foreground hover:text-foreground mb-1 flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm transition-colors"
            >
              <ChevronLeft className="h-4 w-4 shrink-0" />
              <span className="truncate">{backLink.label}</span>
            </Link>
          )}
          <nav className={cn('flex flex-col gap-1', collapsed && 'items-center')}>
            {renderNavItems({ rail: collapsed })}
          </nav>
        </div>

        <div className={cn('flex w-full shrink-0 flex-col gap-1 pt-4', collapsed && 'items-center')}>
          <div className={cn('flex items-center gap-1', collapsed ? 'flex-col' : 'w-full')}>
            <div className={cn(!collapsed && 'min-w-0 flex-1')}>
              <AccountMenu
                email={user?.email}
                variant={collapsed ? 'avatar' : 'row'}
                side={collapsed ? 'right' : 'top'}
              />
            </div>
            <button
              onClick={toggleSidebar}
              aria-label={collapsed ? tc('expandSidebar') : tc('collapseSidebar')}
              title={collapsed ? tc('expandSidebar') : tc('collapseSidebar')}
              className="text-muted-foreground hover:bg-foreground/6 hover:text-foreground flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors"
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Top bar (below lg): brand, the most specific switcher, the menu. Flat, on the page colour. */}
        <header className="sticky top-0 z-50 bg-[#F4F4F2] lg:hidden dark:bg-[#080808]">
          <div className="flex h-14 items-center gap-1.5 px-4">
            <Link
              href={currentOrgId ? `/organization/${currentOrgId}` : '/'}
              aria-label="Aftertalk"
              className="text-foreground shrink-0 transition-opacity hover:opacity-70"
            >
              <Wordmark className="h-5 w-auto" />
            </Link>
            <div className="mx-1.5 h-4 w-px shrink-0 bg-black/10 dark:bg-white/10" />
            <div className="flex min-w-0 flex-1">
              {context.kind === 'project' && orgProjects.length > 0 ? (
                <ProjectSelector
                  projects={orgProjects}
                  currentProjectId={projectId}
                  currentOrgId={currentOrgId}
                  canCreate={canCreateProject}
                />
              ) : (
                <OrgSwitcher organizations={organizations} currentOrgId={currentOrgId} />
              )}
            </div>
            <button
              className="text-muted-foreground hover:bg-foreground/6 hover:text-foreground flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label={tc('toggleMenu')}
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>

          {/* Menu panel — the org switcher (inside a project), the nav, and the account actions */}
          {mobileMenuOpen && (
            <div className="max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-b border-black/[0.07] px-4 pt-1 pb-4 dark:border-white/8">
              {context.kind === 'project' && organizations.length > 0 && (
                <div className="mb-2">
                  <OrgSwitcher organizations={organizations} currentOrgId={currentOrgId} variant="sidebar" />
                </div>
              )}
              {backLink && (
                <Link
                  href={backLink.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-muted-foreground hover:text-foreground mb-1 flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm transition-colors"
                >
                  <ChevronLeft className="h-4 w-4 shrink-0" />
                  <span className="truncate">{backLink.label}</span>
                </Link>
              )}
              <nav className="flex flex-col gap-1">
                {renderNavItems({ mobile: true, onNavigate: () => setMobileMenuOpen(false) })}
              </nav>

              <div className="my-3 h-px bg-black/[0.07] dark:bg-white/8" />
              <div className="flex flex-col gap-1">
                <Link
                  href="/account"
                  onClick={() => setMobileMenuOpen(false)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition-colors',
                    ITEM_IDLE
                  )}
                >
                  <UserRound className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  {t('accountSettings')}
                </Link>
                {/* Each toggle names what is set now ("Motyw: Ciemny"); a bare "Ciemny" could be either. */}
                <button
                  onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors',
                    ITEM_IDLE
                  )}
                >
                  {resolvedTheme === 'dark' ? (
                    <Moon className="h-4 w-4 shrink-0" />
                  ) : (
                    <Sun className="h-4 w-4 shrink-0" />
                  )}
                  {t('theme')}: {resolvedTheme === 'dark' ? t('themeDark') : t('themeLight')}
                </button>
                <button
                  onClick={() => setLocale(otherLocale)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors',
                    ITEM_IDLE
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-semibold">
                    {locale.toUpperCase()}
                  </span>
                  {tc('language')}: {locale === 'pl' ? tc('languages.polish') : tc('languages.english')}
                </button>
                <div className="my-1 h-px bg-black/[0.07] dark:bg-white/8" />
                <div className="text-muted-foreground mb-1 truncate px-2.5 text-xs">{user?.email}</div>
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                >
                  <LogOut className="h-4 w-4 shrink-0" />
                  {t('logout')}
                </button>
              </div>
            </div>
          )}
        </header>

        <main id="content" tabIndex={-1} className="min-w-0 pt-4 outline-none lg:pt-10 lg:pr-[3.125%] lg:pl-4">
          {children}
        </main>
      </div>
    </div>
  );
}
