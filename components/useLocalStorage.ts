"use client";

import { useEffect, useState } from "react";
import { encodeStored, parseStored, quarantineKeyFor } from "@/lib/persistence";

/** Persisted state backed by localStorage, SSR-safe (reads after mount). */
export function useLocalStorage<T>(key: string, initial: T, validate?: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      const parsed = parseStored(raw, initial, validate);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration reads an external browser store
      setValue(parsed.value);
      setStorageError(parsed.error);
      if (raw !== null && parsed.error) {
        // The record failed validation/migration and is about to be reset to
        // the fallback (see the persist effect below), which would otherwise
        // silently destroy it. Stash the raw payload under a sibling key so
        // it stays recoverable.
        try {
          window.localStorage.setItem(quarantineKeyFor(key), raw);
        } catch {
          // best effort — a failed quarantine shouldn't block recovery of the app itself
        }
      }
      if (raw !== null && parsed.migrated) window.localStorage.setItem(key, encodeStored(parsed.value));
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Unable to read saved data.");
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(key, encodeStored(value));
    } catch (error) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- surface external storage failure
      setStorageError(error instanceof Error ? error.message : "Unable to save data.");
    }
  }, [key, value, hydrated]);

  return [value, setValue, hydrated, storageError] as const;
}
