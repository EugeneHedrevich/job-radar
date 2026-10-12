import { useEffect, useState } from 'react';

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status}). Check that the dashboard API is running.`);
  if (payload === null) throw new Error('The API returned an empty response. Check that the dashboard API is running.');
  return payload as T;
}

export function useResource<T>(url: string | null, revision: number, keepPreviousData = false) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!keepPreviousData || !url) setData(null);
    setError(null); setLoading(Boolean(url));
    if (url) {
      request<T>(url, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) setData(result); })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load data');
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
    return () => controller.abort();
  }, [url, revision, keepPreviousData]);
  return { data, setData, loading, error };
}
