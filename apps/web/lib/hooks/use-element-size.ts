'use client';

/**
 * Measures an element's dimensions via ResizeObserver and returns them only once
 * they are positive (> 0). Designed to gate Recharts charts from rendering until
 * the container has a real layout size.
 *
 * Background: Recharts' ResponsiveContainer starts with width/height = -1 and
 * resolves real dimensions asynchronously via its own internal ResizeObserver.
 * This causes a noisy console warning on every chart mount, both during SSR
 * (no DOM available) and on the first client render (before the observer fires).
 * Passing explicit numeric width/height to ResponsiveContainer bypasses its
 * internal measurement entirely — it never sees -1. By withholding those props
 * until we have a real measurement ourselves, we avoid the warning without
 * introducing a visible layout shift (the container div still occupies its CSS
 * height via h-[...] while the chart is pending).
 */

import { useEffect, useRef, useState } from 'react';

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}
