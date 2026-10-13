import { useEffect, useState } from 'react';

export interface EuroRate { plnPerEuro: number; effectiveDate: string }
export interface EuroConversion { rate: EuroRate | null; unavailable: boolean }

const NBP_URL = 'https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json';
let cached: { rate: EuroRate; fetchedAt: number } | null = null;

async function loadEuroRate(signal: AbortSignal): Promise<EuroRate> {
  if (cached && Date.now() - cached.fetchedAt < 3_600_000) return cached.rate;
  const response = await fetch(NBP_URL, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('EUR conversion unavailable');
  const payload = await response.json() as { table?: unknown; code?: unknown; rates?: unknown };
  const quote = Array.isArray(payload?.rates) ? payload.rates[0] as
    { mid?: unknown; effectiveDate?: unknown } | undefined : undefined;
  if (payload?.table !== 'A' || payload.code !== 'EUR' || !quote ||
    typeof quote.mid !== 'number' || !Number.isFinite(quote.mid) || quote.mid <= 0 ||
    typeof quote.effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(quote.effectiveDate)) {
    throw new Error('Invalid EUR exchange rate');
  }
  const rate = { plnPerEuro: quote.mid, effectiveDate: quote.effectiveDate };
  cached = { rate, fetchedAt: Date.now() };
  return rate;
}

/** One shared quote for visible PLN salaries, reused for an hour. */
export function useEuroRate(needed: boolean, revision: number): EuroConversion {
  const [rate, setRate] = useState<EuroRate | null>(cached?.rate ?? null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!needed) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setUnavailable(false);
    loadEuroRate(controller.signal)
      .then((value) => { if (active) setRate(value); })
      .catch(() => { if (active) setUnavailable(true); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [needed, revision]);
  return { rate, unavailable };
}
