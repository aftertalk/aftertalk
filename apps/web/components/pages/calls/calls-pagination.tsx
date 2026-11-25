'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useCallsNavigation } from '@/components/pages/calls/calls-navigation';
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from '@/components/pages/calls/page-sizes';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { i18n } from '@/i18n/constants';
import { cn } from '@/lib/utils/cn';

interface CallsPaginationProps {
  projectId: string;
  currentPage: number;
  totalPages: number;
  total: number;
  pageSize: number;
  filterQuery?: string;
}

function getPageNumbers(currentPage: number, totalPages: number): (number | 'ellipsis')[] {
  const pages: (number | 'ellipsis')[] = [];
  const delta = 2;

  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== 'ellipsis') {
      pages.push('ellipsis');
    }
  }

  return pages;
}

export function CallsPagination({
  projectId,
  currentPage,
  totalPages,
  total,
  pageSize,
  filterQuery,
}: CallsPaginationProps) {
  const t = useTranslations();
  const { navigate } = useCallsNavigation();
  const [open, setOpen] = useState(false);

  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, total);
  const pageNumbers = getPageNumbers(currentPage, totalPages);

  const buildHref = (pageNum: number) => {
    const params = new URLSearchParams(filterQuery);
    if (pageNum > 1) params.set('page', String(pageNum));
    const qs = params.toString();
    return `/${projectId}/calls${qs ? `?${qs}` : ''}`;
  };

  // Plain links stay middle-clickable; an ordinary click goes through the list's transition instead.
  const linkProps = (pageNum: number) => {
    const href = buildHref(pageNum);
    return {
      href,
      onClick: (e: React.MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      },
    };
  };

  const handleSizeChange = (size: number) => {
    const params = new URLSearchParams(filterQuery);
    if (size === DEFAULT_PAGE_SIZE) {
      params.delete('size');
    } else {
      params.set('size', String(size));
    }
    const qs = params.toString();
    navigate(`/${projectId}/calls${qs ? `?${qs}` : ''}`);
    setOpen(false);
  };

  if (totalPages <= 1 && total <= Math.min(...PAGE_SIZES)) {
    return null;
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              {currentPage > 1 ? (
                <PaginationPrevious {...linkProps(currentPage - 1)} />
              ) : (
                <PaginationPrevious aria-disabled className="pointer-events-none opacity-50" />
              )}
            </PaginationItem>

            {pageNumbers.map((pageNum, index) =>
              pageNum === 'ellipsis' ? (
                <PaginationItem key={`ellipsis-${index}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={pageNum}>
                  <PaginationLink
                    {...linkProps(pageNum)}
                    isActive={pageNum === currentPage}
                    className={cn(
                      'text-meta tabular-nums',
                      pageNum === currentPage && 'text-foreground bg-foreground/[0.08] border-transparent'
                    )}
                  >
                    {pageNum}
                  </PaginationLink>
                </PaginationItem>
              )
            )}

            <PaginationItem>
              {currentPage < totalPages ? (
                <PaginationNext {...linkProps(currentPage + 1)} />
              ) : (
                <PaginationNext aria-disabled className="pointer-events-none opacity-50" />
              )}
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}

      {/* Caption — the end number is the inline page-size trigger */}
      <div className="text-meta text-muted-foreground relative">
        {(() => {
          const raw = t(i18n.calls.pagination.showing, { start, end: '\x00', total });
          const [before, after] = raw.split('\x00');
          return (
            <span>
              {before}
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="text-foreground/80 hover:text-foreground rounded px-0.5 font-medium tabular-nums underline decoration-dashed underline-offset-2 transition-colors"
              >
                {end}
              </button>
              {after}
            </span>
          );
        })()}

        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="bg-popover absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 overflow-hidden rounded-xl p-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.07] dark:ring-white/10">
              {PAGE_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => handleSizeChange(size)}
                  className={cn(
                    'text-meta w-full rounded-lg px-4 py-1.5 text-center whitespace-nowrap transition-colors',
                    size === pageSize
                      ? 'text-foreground bg-foreground/[0.08] font-medium'
                      : 'text-foreground/80 hover:bg-foreground/[0.04]'
                  )}
                >
                  {t(i18n.calls.pagination.perPage, { size })}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
