"use client";

import {useCallback, useEffect, useRef, useState} from 'react';
import type {MonthlySnapshot} from './monthly-types';

const POLL_MS = 15000;
const TIMEOUT_MS = 15000;
type ReadState = {siteId: string; snapshot: MonthlySnapshot | null; refreshing: boolean; error: string};
type Session = {siteId: string; reload: () => Promise<void>};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readSnapshot(siteId: string, signal: AbortSignal): Promise<MonthlySnapshot> {
  const response = await fetch(`/api/monthly-data?siteId=${encodeURIComponent(siteId)}`, {
    method: 'GET', cache: 'no-store', credentials: 'same-origin',
    headers: {'Accept': 'application/json', 'Cache-Control': 'private, no-store'}, signal,
  });
  const text = await response.text();
  let data: unknown;
  try {data = JSON.parse(text);} catch {throw new Error(`Monthly response unavailable (${response.status}).`);}
  if (!response.ok) throw new Error(record(data) && typeof data.error === 'string' ? data.error : `Unable to read monthly data (${response.status}).`);
  if (!record(data)) throw new Error('Invalid monthly response.');
  if (data.siteId !== siteId) throw new Error('Monthly response belongs to a different site.');
  if (typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision) ||
      !record(data.configuration) || !record(data.utility) || !Array.isArray(data.projections) ||
      !record(data.telemetry) || !record(data.telemetry.months) || !record(data.capacity) || !record(data.calculated)) {
    throw new Error('Incomplete monthly response; saved data could not be read.');
  }
  return data as MonthlySnapshot;
}

/** Independent read-only lifecycle: no monthly editor drafts, guards or writes. */
export function useMonthlyChartData(siteId: string): {
  snapshot: MonthlySnapshot | null; refreshing: boolean; error: string; reload: () => Promise<void>;
} {
  const [state, setState] = useState<ReadState>(() => ({siteId, snapshot: null, refreshing: !!siteId, error: ''}));
  const active = useRef<Session | null>(null);

  const reload = useCallback(async () => {
    const session = active.current;
    if (session?.siteId === siteId) await session.reload();
  }, [siteId]);

  useEffect(() => {
    let disposed = false, generation = 0;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let cancelRequest: (() => void) | null = null;
    const session: Session = {siteId, reload: load};
    active.current = session;
    setState({siteId, snapshot: null, refreshing: !!siteId, error: ''});

    function current(sequence: number): boolean {
      return !disposed && active.current === session && generation === sequence;
    }
    async function load(): Promise<void> {
      if (!siteId || disposed || active.current !== session) return;
      const sequence = ++generation;
      if (poll !== undefined) {clearTimeout(poll); poll = undefined;}
      // An explicit reload supersedes the old request, even when its transport
      // ignores abort. Polls are scheduled only after settlement, never stacked.
      cancelRequest?.();
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        cancelRequest = () => {
          if (timeout !== undefined) clearTimeout(timeout);
          reject(new Error('Monthly read was superseded.'));
          controller.abort();
        };
        timeout = setTimeout(() => {
          reject(new Error('Monthly read timed out after 15 seconds. Retry to check freshness.'));
          controller.abort();
        }, TIMEOUT_MS);
      });
      setState(previous => ({siteId, snapshot: previous.siteId === siteId ? previous.snapshot : null, refreshing: true, error: ''}));
      try {
        // Race the whole response/body read; abort alone cannot release a
        // hung transport or a body parser that does not honor its signal.
        const snapshot = await Promise.race([readSnapshot(siteId, controller.signal), interrupted]);
        if (current(sequence)) {
          // Always accept the new object. DC-model edits can change calculated
          // values while monthly and telemetry revision numbers stay identical.
          setState({siteId, snapshot, refreshing: false, error: ''});
        }
      } catch (error) {
        if (current(sequence)) setState(previous => ({
          siteId, snapshot: previous.siteId === siteId ? previous.snapshot : null, refreshing: false,
          error: error instanceof Error ? error.message : 'Unable to read monthly data; telemetry freshness is unavailable.',
        }));
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (current(sequence)) {
          cancelRequest = null;
          poll = setTimeout(() => {poll = undefined; void load();}, POLL_MS);
        }
      }
    }

    if (siteId) void load();
    return () => {
      disposed = true;
      generation++;
      if (poll !== undefined) clearTimeout(poll);
      cancelRequest?.();
      cancelRequest = null;
      if (active.current === session) active.current = null;
    };
  }, [siteId]);

  // Effects run after render. Fence by identity here as well as at acceptance
  // so even the first render after selecting another site cannot show old data.
  return state.siteId === siteId ? {snapshot: state.snapshot, refreshing: state.refreshing, error: state.error, reload} :
    {snapshot: null, refreshing: !!siteId, error: '', reload};
}
