'use client';

import { FileText, TrendingUp, Upload } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n/constants';
import { cn } from '@/lib/utils/cn';

interface DashboardQuickActionsProps {
  projectId: string;
}

export function DashboardQuickActions({ projectId }: DashboardQuickActionsProps) {
  const t = useTranslations();

  const actions = [
    {
      icon: Upload,
      title: t(i18n.dashboard.quickActions.uploadTitle),
      description: t(i18n.dashboard.quickActions.uploadDescription),
      button: t(i18n.dashboard.quickActions.uploadButton),
      href: `/${projectId}/upload`,
      primary: true,
    },
    {
      icon: TrendingUp,
      title: t(i18n.dashboard.quickActions.analyticsTitle),
      description: t(i18n.dashboard.quickActions.analyticsDescription),
      button: t(i18n.dashboard.quickActions.analyticsButton),
      href: `/${projectId}/calls`,
      primary: false,
    },
    {
      icon: FileText,
      title: t(i18n.dashboard.quickActions.apiTitle),
      description: t(i18n.dashboard.quickActions.apiDescription),
      button: t(i18n.dashboard.quickActions.apiButton),
      href: `/${projectId}/settings`,
      primary: false,
    },
  ];

  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {actions.map((action) => (
        <div
          key={action.href}
          className={cn(
            'group relative flex flex-col overflow-hidden rounded-2xl border px-5 py-5 transition-all duration-200',
            'border-black/[0.07] bg-white shadow-[0_4px_20px_rgba(0,0,0,0.06),0_1px_4px_rgba(0,0,0,0.04)]',
            'hover:-translate-y-0.5 hover:border-black/[0.1] hover:shadow-[0_8px_30px_rgba(0,0,0,0.10),0_2px_8px_rgba(0,0,0,0.06)]',
            'dark:border-white/8 dark:bg-white/4 dark:shadow-none dark:hover:border-white/12'
          )}
        >
          <div
            className={cn(
              'mb-3 flex h-10 w-10 items-center justify-center rounded-xl',
              action.primary
                ? 'from-brand-coral/15 to-brand-coral/5 text-brand-coral bg-gradient-to-br'
                : 'text-muted-foreground bg-black/[0.03] dark:bg-white/[0.06]'
            )}
          >
            <action.icon className="h-5 w-5" strokeWidth={1.5} />
          </div>

          <h3 className="text-foreground text-sm font-semibold tracking-tight">{action.title}</h3>
          <p className="text-muted-foreground mt-1 flex-1 text-xs leading-relaxed">{action.description}</p>

          <div className="mt-4">
            <Link href={action.href}>
              <Button
                variant={action.primary ? 'default' : 'outline'}
                size="sm"
                className={cn('w-full rounded-xl text-xs', action.primary && 'shadow-[0_2px_8px_rgba(243,85,60,0.25)]')}
              >
                <action.icon className="mr-1.5 h-3.5 w-3.5" />
                {action.button}
              </Button>
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
