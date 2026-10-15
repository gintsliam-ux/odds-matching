import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A filter that lives in the URL.
 *
 * Every toggle on these pages used to be component state, which meant the
 * address bar said `/movers` whether you were looking at every market or the
 * nine that had moved 5% since open — so a view could be arrived at but never
 * sent to anyone, and a refresh threw it away.
 *
 * `replace` rather than `push`, deliberately: clicking four filter chips should
 * not put four entries in the history and make Back a slow walk out of the
 * page. The URL is a description of where you are, not a record of how you got
 * there.
 *
 * A value equal to the default is REMOVED from the query rather than written,
 * so the common view has a clean URL and what remains in it is what somebody
 * actually chose.
 */
export function useParam(key: string, fallback: string): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;

  const set = useCallback(
    (v: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (!v || v === fallback) next.delete(key);
          else next.set(key, v);
          return next;
        },
        { replace: true },
      );
    },
    [key, fallback, setParams],
  );

  return [value, set];
}

/** The same, for a number — the page keeps its arithmetic, the URL keeps text. */
export function useNumParam(
  key: string,
  fallback: number,
): [number, (v: number) => void] {
  const [raw, setRaw] = useParam(key, String(fallback));
  const parsed = Number(raw);
  return [
    Number.isFinite(parsed) ? parsed : fallback,
    useCallback((v: number) => setRaw(String(v)), [setRaw]),
  ];
}

/** And for a flag, present or absent rather than `=true` / `=false`. */
export function useFlagParam(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [raw, setRaw] = useParam(key, fallback ? '1' : '');
  return [
    raw === '1' || raw === 'true',
    useCallback((v: boolean) => setRaw(v ? '1' : ''), [setRaw]),
  ];
}
