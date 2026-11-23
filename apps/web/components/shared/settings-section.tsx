import { Surface } from '@/components/ui/surface';
import { cn } from '@/lib/utils/cn';

// Shared layout for settings and configuration pages (Stripe-style): what a section is about on the
// left, its controls on the right, so wide screens hold two columns instead of one stretched form.
// Stack sections inside <SettingsSections> (hairline between them), rows inside a section's Surface.

export function SettingsSections({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">{children}</div>;
}

interface SettingsSectionProps {
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** `split`: text left, controls right. `stacked`: header on top, full-width list below (tables, lists). */
  layout?: 'split' | 'stacked';
  /** Right side of a stacked section's header (e.g. "Dodaj"). */
  actions?: React.ReactNode;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}

export function SettingsSection({
  id,
  title,
  description,
  layout = 'split',
  actions,
  tone = 'default',
  children,
}: SettingsSectionProps) {
  const heading = (
    <div className="min-w-0">
      <h2 className="text-title text-foreground font-medium">{title}</h2>
      {description && <p className="text-body text-muted-foreground mt-2 max-w-[40ch]">{description}</p>}
    </div>
  );

  if (layout === 'stacked') {
    return (
      <section id={id} className="space-y-5 py-10 first:pt-0">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          {heading}
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </div>
        <Surface pad="none" tone={tone}>
          {children}
        </Surface>
      </section>
    );
  }

  return (
    <section id={id} className="grid gap-6 py-10 first:pt-0 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:gap-16">
      <div className="lg:sticky lg:top-24 lg:self-start">{heading}</div>
      <Surface pad="none" tone={tone} className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
        {children}
      </Surface>
    </section>
  );
}

interface SettingsRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  htmlFor?: string;
  /** Inline feedback shown before the control ("Zapisano", a badge, …). */
  status?: React.ReactNode;
  /** The control: a switch, select, input or button. Full width on phones, a fixed column above. */
  children: React.ReactNode;
  /** Let wide controls (inputs, textareas) take the whole row below the label. */
  wide?: boolean;
  className?: string;
}

export function SettingsRow({ label, description, htmlFor, status, children, wide, className }: SettingsRowProps) {
  return (
    <div
      className={cn(
        'grid gap-3 px-5 py-5 md:px-6',
        // Settings use the full width like every other page. On a wide screen the control would then sit far
        // from its label, so from xl the label gets a column of its own and the control starts beside it.
        !wide &&
          'sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-10 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]',
        className
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-body text-foreground block font-medium">
          {label}
        </label>
        {description && <p className="text-meta text-muted-foreground mt-1 max-w-[56ch]">{description}</p>}
      </div>
      <div className={cn('flex items-center gap-3', !wide && 'sm:justify-end xl:justify-start')}>
        {status}
        {children}
      </div>
    </div>
  );
}
