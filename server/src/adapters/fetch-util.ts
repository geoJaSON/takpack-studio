/**
 * Shared HTTP helpers for imagery adapters.
 *
 * Fetch injection: tests call `setFetchImpl(mock)` to intercept every request
 * made by the adapters (no network in tests); `setFetchImpl(null)` restores
 * the global fetch. Production code never calls it.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike | null = null;

/** Inject a fetch implementation for tests; pass null to restore global fetch. */
export function setFetchImpl(impl: FetchLike | null): void {
  fetchImpl = impl;
}

export function getFetchImpl(): FetchLike {
  return fetchImpl ?? ((url, init) => fetch(url, init));
}

export const USER_AGENT = "TAKPack-Studio/0.1";
export const DEFAULT_TIMEOUT_MS = 12_000;

export interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
}

/** Fetch with UA + timeout, chained to any caller signal. Null on failure/non-2xx. */
async function fetchResponse(
  url: string,
  opts: FetchOptions,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await getFetchImpl()(url, {
      method: opts.method ?? "GET",
      headers: { "User-Agent": USER_AGENT, ...opts.headers },
      body: opts.body,
      signal: ctrl.signal,
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Fetch a binary body. Returns null on any failure, timeout, or non-2xx. */
export async function fetchBinary(
  url: string,
  opts: FetchOptions = {},
): Promise<Buffer | null> {
  const res = await fetchResponse(url, opts);
  if (!res) return null;
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Fetch + parse a JSON body. Returns null on any failure. */
export async function fetchJson<T>(
  url: string,
  opts: FetchOptions = {},
): Promise<T | null> {
  const res = await fetchResponse(url, opts);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Run async jobs with bounded parallelism; results preserve job order.
 * Jobs should capture their own failures (e.g. resolve null) — a rejected
 * job rejects the whole batch.
 */
export async function runBounded<T>(
  jobs: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, jobs.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        results[i] = await jobs[i]();
      }
    },
  );
  await Promise.all(workers);
  return results;
}
