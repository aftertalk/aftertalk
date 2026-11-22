'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

/** Item 30: tells the user, once, that their password was reset. The server already cleared it. */
export function ResetNotice({ text }: { text: string }) {
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    toast.info(text, { duration: 15000 });
  }, [text]);
  return null;
}
