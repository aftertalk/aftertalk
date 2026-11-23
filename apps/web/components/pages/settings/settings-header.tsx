'use client';

import { useTranslations } from 'next-intl';

import { PageHeader } from '@/components/shared/page-header';
import { i18n } from '@/i18n/constants';

export function SettingsHeader() {
  const t = useTranslations();

  return <PageHeader title={t(i18n.settings.header.title)} description={t(i18n.settings.header.description)} />;
}
