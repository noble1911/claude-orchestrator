import { useState, useEffect, type Dispatch, type SetStateAction } from "react";

/**
 * Like useState, but persists to localStorage under the given key.
 * On mount, reads the stored value (parsed via `deserialize`); on every
 * state change, writes it back (serialized via `serialize`).
 *
 * Defaults to JSON.stringify / JSON.parse for non-string types.
 * For simple string values, pass identity functions.
 *
 * If `serialize` returns `null`, the key is removed from localStorage
 * (useful for cleaning up empty objects/arrays).
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  serialize: (v: T) => string | null = JSON.stringify,
  deserialize: (raw: string) => T = JSON.parse,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? deserialize(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    const serialized = serialize(value);
    if (serialized === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, serialized);
    }
  }, [key, serialize, value]);

  return [value, setValue];
}
