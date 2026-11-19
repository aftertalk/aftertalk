import { cn } from '@/lib/utils/cn';

interface SectionContainerProps {
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
  id?: string;
}

export function SectionContainer({ children, className, innerClassName, id }: SectionContainerProps) {
  return (
    <section id={id} className={cn('py-20', className)}>
      <div className={cn('mx-auto px-[6.25%]', innerClassName)}>{children}</div>
    </section>
  );
}
