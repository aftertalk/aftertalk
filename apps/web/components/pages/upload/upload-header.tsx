'use client';

import { useTranslations } from 'next-intl';

import { PageHeader } from '@/components/shared/page-header';
import { i18n } from '@/i18n/constants';

export function UploadHeader({ eyebrow }: { eyebrow?: string }) {
  const t = useTranslations();

  return (
    <PageHeader eyebrow={eyebrow} title={t(i18n.upload.header.title)} description={t(i18n.upload.header.description)} />
  );
}
