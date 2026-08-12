export interface PlayerAnnotation { target: boolean; avoid: boolean; note: string }
export type AnnotationStore = Record<string, PlayerAnnotation>;
export const EMPTY_ANNOTATION: PlayerAnnotation = { target: false, avoid: false, note: "" };

export function annotationKey(season: string, playerId: string): string {
  return `${season}:${playerId}`;
}

export function updateAnnotation(store: AnnotationStore, season: string, playerId: string, patch: Partial<PlayerAnnotation>): AnnotationStore {
  const key = annotationKey(season, playerId);
  const next = { ...(store[key] ?? EMPTY_ANNOTATION), ...patch };
  if (!next.target && !next.avoid && !next.note.trim()) {
    const copy = { ...store }; delete copy[key]; return copy;
  }
  if (next.target && next.avoid) next.avoid = false;
  return { ...store, [key]: next };
}

