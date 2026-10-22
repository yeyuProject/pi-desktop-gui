import { useRef } from 'react';

/** Stable within one selection; old controls retain their original ownership guards. */
export function useStableCallbacks<T extends object>(value: T, scope: string): T {
  const latest = useRef({ value, scope });
  latest.current = { value, scope };
  const callbacks = useRef(new Map<keyof T, (...args: unknown[]) => unknown>());
  const previousScope = useRef(scope);
  if (previousScope.current !== scope) {
    callbacks.current = new Map();
    previousScope.current = scope;
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      const key = name as keyof T;
      if (typeof item !== 'function') return [key, item];
      if (!callbacks.current.has(key))
        callbacks.current.set(key, (...args) =>
          (
            (latest.current.scope === scope ? latest.current.value[key] : item) as (
              ...values: unknown[]
            ) => unknown
          )(...args),
        );
      return [key, callbacks.current.get(key)];
    }),
  ) as T;
}
