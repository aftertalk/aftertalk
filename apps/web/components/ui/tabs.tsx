'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as React from 'react';

import { cn } from '@/lib/utils/cn';

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />;
}

// Line tabs: a hairline under the row, the active tab underlined in its own text colour. The one tab style
// in the app: rows that switch a view or the URL rather than Radix content use these classes on plain
// buttons in a role="group", with aria-pressed and data-state="active" on the current one. (They aren't
// ARIA tabs: that would promise arrow-key navigation they don't have.)
export const TAB_LIST_CLASS = 'border-foreground/[0.06] flex gap-6 overflow-x-auto border-b';
export const TAB_TRIGGER_CLASS =
  "text-body text-muted-foreground hover:text-foreground data-[state=active]:text-foreground focus-visible:ring-ring/50 inline-flex shrink-0 items-center gap-1.5 pb-3 whitespace-nowrap transition-colors outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-[inset_0_-1px_0_currentColor] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn(TAB_LIST_CLASS, className)} {...props} />;
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn(TAB_TRIGGER_CLASS, className)} {...props} />;
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
