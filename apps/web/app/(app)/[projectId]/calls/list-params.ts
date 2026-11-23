import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from '@/components/pages/calls/page-sizes';
import { getCallsFiltered, searchCalls } from '@/lib/action/transcription';
import type { Call, CallSearchResult } from '@/lib/types';
import type { DateRangeInput, DateRangePreset } from '@/lib/utils/date-range';
import { ISO_DATE_RE, isValidDateRangeInput, resolveDateRange, VALID_PRESETS } from '@/lib/utils/date-range';

// The list and the call page read the same query string: the call page keeps it so "← Rozmowy" returns
// to the same page of the same list, and so it can work out where in that list the call sits.

export interface CallsSearchParams {
  page?: string;
  size?: string;
  range?: string;
  from?: string;
  to?: string;
  q?: string;
}

function buildDateRange(params: CallsSearchParams): DateRangeInput {
  const { range, from, to } = params;

  // Defaults to all-time, unlike the dashboard: a "library" that hides older calls reads as empty
  const preset = range && VALID_PRESETS.includes(range as DateRangePreset) ? (range as DateRangePreset) : 'allTime';

  if (preset === 'custom') {
    const validFrom = from && ISO_DATE_RE.test(from) ? from : undefined;
    const validTo = to && ISO_DATE_RE.test(to) ? to : undefined;
    if (!validFrom || !validTo) return { preset: 'allTime' };
    // A hand-edited URL can carry a range the backend rejects (e.g. over a year); fall back instead of crashing the page
    const custom: DateRangeInput = { preset: 'custom', from: validFrom, to: validTo };
    return isValidDateRangeInput(custom) ? custom : { preset: 'allTime' };
  }

  return { preset };
}

export function parseCallsParams(params: CallsSearchParams) {
  const page = Math.max(1, parseInt(params.page || '1', 10) || 1);
  const requestedSize = parseInt(params.size || String(DEFAULT_PAGE_SIZE), 10);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(requestedSize) ? requestedSize : DEFAULT_PAGE_SIZE;
  const q = params.q?.trim() ?? '';

  // Date filter and page size, without q and page: what the search bar keeps when it navigates.
  const baseQuery = new URLSearchParams();
  if (params.range) baseQuery.set('range', params.range);
  if (params.from) baseQuery.set('from', params.from);
  if (params.to) baseQuery.set('to', params.to);
  if (pageSize !== DEFAULT_PAGE_SIZE) baseQuery.set('size', String(pageSize));

  // Plus q: what pagination keeps.
  const filterQuery = new URLSearchParams(baseQuery);
  if (q) filterQuery.set('q', q);

  return { page, pageSize, q, dateRange: buildDateRange(params), baseQuery, filterQuery };
}

export type CallsListParams = ReturnType<typeof parseCallsParams>;

/** The list query for a given page, as it appears in the URL ("" for the first page of the default list). */
export function listQuery(list: CallsListParams, page: number): string {
  const query = new URLSearchParams(list.filterQuery);
  if (page > 1) query.set('page', String(page));
  return query.toString();
}

export async function fetchCallsPage(projectId: string, list: CallsListParams, page: number) {
  if (list.q) {
    const { from, to } = resolveDateRange(list.dateRange);
    const result = await searchCalls(projectId, {
      q: list.q,
      page,
      pageSize: list.pageSize,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return {
      calls: result.data as (Call | CallSearchResult)[],
      total: result.total,
      totalPages: result.totalPages,
      pageSize: result.pageSize,
      snippets: Object.fromEntries(result.data.map((r) => [r.id, r.snippet])) as Record<string, string>,
    };
  }

  const result = await getCallsFiltered(projectId, { page, pageSize: list.pageSize, dateRange: list.dateRange });
  return {
    calls: result.data as (Call | CallSearchResult)[],
    total: result.total,
    totalPages: result.totalPages,
    pageSize: result.pageSize,
    snippets: undefined,
  };
}

export interface CallNeighbours {
  position: number;
  total: number;
  prevHref: string | null;
  nextHref: string | null;
}

/**
 * Where the call sits in the list it was opened from ("3 z 41") and its neighbours. Only the list page
 * in the URL is read, plus the adjacent page when the call is first or last on it. Null when the call
 * isn't on that page (opened from elsewhere, or the list moved on), and the counter is then left out.
 */
export async function getCallNeighbours(
  projectId: string,
  callId: string,
  list: CallsListParams
): Promise<CallNeighbours | null> {
  const current = await fetchCallsPage(projectId, list, list.page);
  const index = current.calls.findIndex((c) => c.id === callId);
  if (index < 0) return null;

  const href = (id: string, page: number) => {
    const query = listQuery(list, page);
    return `/${projectId}/calls/${id}${query ? `?${query}` : ''}`;
  };

  const isFirst = index === 0;
  const isLast = index === current.calls.length - 1;
  const [prevPage, nextPage] = await Promise.all([
    isFirst && list.page > 1 ? fetchCallsPage(projectId, list, list.page - 1) : null,
    isLast && list.page < current.totalPages ? fetchCallsPage(projectId, list, list.page + 1) : null,
  ]);

  const prev = isFirst ? prevPage?.calls.at(-1) : current.calls[index - 1];
  const next = isLast ? nextPage?.calls[0] : current.calls[index + 1];

  return {
    position: (list.page - 1) * current.pageSize + index + 1,
    total: current.total,
    prevHref: prev ? href(prev.id, isFirst ? list.page - 1 : list.page) : null,
    nextHref: next ? href(next.id, isLast ? list.page + 1 : list.page) : null,
  };
}
