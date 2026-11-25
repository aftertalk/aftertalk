interface PageHeaderProps {
  title: React.ReactNode;
  /** Small mono line above the title: where the page sits ("TeleNova · Sprzedaż") or what it is. */
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions (date picker, primary button, …). */
  children?: React.ReactNode;
}

// The single page-title treatment for every app page, so headers don't drift. Same voice as the
// landing: mono eyebrow, a big tight title, a quiet one-line description.
export function PageHeader({ title, eyebrow, description, children }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 pb-2 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-muted-foreground mb-3 truncate font-mono text-xs tracking-[0.18em] uppercase">{eyebrow}</p>
        )}
        <h1 className="text-foreground md:text-display text-[2rem] leading-[1.05] tracking-[-0.04em]">{title}</h1>
        {description && <p className="text-body text-muted-foreground mt-2 max-w-2xl">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
