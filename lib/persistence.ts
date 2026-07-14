export const STORAGE_VERSION = 1;
export interface StorageEnvelope<T> { version: number; season?: string; data: T }
export interface ParseResult<T> { value: T; migrated: boolean; error: string | null }

export function encodeStored<T>(data: T, season?: string): string {
  return JSON.stringify({ version: STORAGE_VERSION, ...(season ? { season } : {}), data });
}

export function parseStored<T>(raw: string | null, fallback: T, validate?: (value: unknown) => value is T): ParseResult<T> {
  if (raw === null) return { value: fallback, migrated: false, error: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    const envelope = parsed && typeof parsed === "object" && "version" in parsed && "data" in parsed ? parsed as StorageEnvelope<unknown> : null;
    if (envelope && envelope.version > STORAGE_VERSION) return { value: fallback, migrated: false, error: "Saved data is from a newer app version." };
    const candidate = envelope ? envelope.data : parsed;
    if (validate && !validate(candidate)) return { value: fallback, migrated: false, error: "Saved data was invalid and has been reset." };
    return { value: candidate as T, migrated: !envelope, error: null };
  } catch {
    return { value: fallback, migrated: false, error: "Saved data was malformed and has been reset." };
  }
}

