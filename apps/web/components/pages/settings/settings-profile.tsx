'use client';

import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SettingsRow, SettingsSection } from '@/components/shared/settings-section';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { APP_TIME_ZONE } from '@/i18n/config';
import { i18n } from '@/i18n/constants';
import { updateTimeZone } from '@/lib/action/account';

const TIME_ZONES = [
  { value: 'Europe/Warsaw', label: i18n.settings.profile.timezones.warsaw },
  { value: 'Europe/London', label: i18n.settings.profile.timezones.london },
  { value: 'America/New_York', label: i18n.settings.profile.timezones.newYork },
  { value: 'Asia/Tokyo', label: i18n.settings.profile.timezones.tokyo },
];

// Today's offset ("GMT+2"), so the label stays right across daylight-saving changes.
function currentOffset(timeZone: string, locale: string): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'shortOffset' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
    );
  } catch {
    return '';
  }
}

type Field = 'timezone' | 'language';

export function SettingsProfile() {
  const t = useTranslations();
  const locale = useLocale();
  // The request's zone, which TimeZoneSync keeps equal to the account's.
  const timeZone = useTimeZone() ?? APP_TIME_ZONE;
  const router = useRouter();
  const [zone, setZone] = useState(timeZone);
  const [language, setLanguage] = useState(locale);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState<Field | null>(null);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(null), 2500);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const zoneLabel = (value: string, labelKey?: string) => {
    const offset = currentOffset(value, locale);
    const name = labelKey ? t(labelKey) : value;
    return offset ? `${name} (${offset})` : name;
  };

  // Each choice saves as it's made; there is no form to submit.
  const changeZone = async (value: string) => {
    if (value === zone) return;
    const previous = zone;
    setZone(value);
    setSaving(true);
    // A refused zone comes back as a result; a failure that isn't the user's to fix (5xx, network) throws.
    const result = await updateTimeZone(value).catch(() => null);
    setSaving(false);
    if (!result?.ok) {
      setZone(previous);
      toast.error(result?.error ?? t(i18n.appError.title));
      return;
    }
    setJustSaved('timezone');
    router.refresh();
  };

  const changeLanguage = (value: string) => {
    if (value === language) return;
    setLanguage(value);
    document.cookie = `NEXT_LOCALE=${value}; path=/; max-age=${60 * 60 * 24 * 365}`;
    setJustSaved('language');
    router.refresh();
  };

  const saved = (field: Field) =>
    justSaved === field && (
      <span className="text-meta text-muted-foreground flex items-center gap-1 whitespace-nowrap" role="status">
        <Check className="h-3.5 w-3.5" />
        {t(i18n.settings.profile.savedInline)}
      </span>
    );

  return (
    <SettingsSection title={t(i18n.settings.profile.title)} description={t(i18n.settings.profile.description)}>
      <SettingsRow label={t(i18n.settings.profile.timezone)} htmlFor="timezone" status={saved('timezone')}>
        <Select value={zone} onValueChange={changeZone} disabled={saving}>
          <SelectTrigger id="timezone" className="w-full sm:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_ZONES.map((z) => (
              <SelectItem key={z.value} value={z.value}>
                {zoneLabel(z.value, z.label)}
              </SelectItem>
            ))}
            {/* A zone saved some other way (the API) still shows as selected. */}
            {!TIME_ZONES.some((z) => z.value === timeZone) && (
              <SelectItem value={timeZone}>{zoneLabel(timeZone)}</SelectItem>
            )}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow label={t(i18n.settings.profile.language)} htmlFor="language" status={saved('language')}>
        <Select value={language} onValueChange={changeLanguage}>
          <SelectTrigger id="language" className="w-full sm:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pl">{t(i18n.common.languages.polish)}</SelectItem>
            <SelectItem value="en">{t(i18n.common.languages.english)}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsSection>
  );
}
