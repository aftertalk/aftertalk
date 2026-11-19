import { cn } from '@/lib/utils/cn';

interface TextLinkProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export function TextLink({ className, children, ...props }: TextLinkProps) {
  return (
    <button
      type="button"
      className={cn('underline underline-offset-4 transition-opacity hover:opacity-70', className)}
      {...props}
    >
      {children}
    </button>
  );
}
