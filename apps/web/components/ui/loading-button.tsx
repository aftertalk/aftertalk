import { Loader2 } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';

interface LoadingButtonProps extends ButtonProps {
  /** Shows a spinner (replacing `icon`, or leading the label) and disables the button while true. */
  loading?: boolean;
  /** Optional leading icon; swapped for the spinner while loading. */
  icon?: React.ReactNode;
}

/**
 * Button that owns its busy state: one place for the spinner + disabled behaviour, so callers don't
 * re-implement it. Inherits every Button variant, so hover/active/focus styling stays consistent.
 */
export function LoadingButton({ loading = false, disabled, icon, children, ...props }: LoadingButtonProps) {
  return (
    <Button disabled={disabled || loading} aria-busy={loading} {...props}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </Button>
  );
}
