export interface BoardingPointConfig {
  id: string;
  location: string;
  time: string;
}

/**
 * Indica si el punto de abordaje guardado en un pasajero corresponde a un punto configurado
 * en el tour. Es tolerante a los tres formatos que se han guardado históricamente:
 * el id del punto, la ubicación o el compuesto "ubicación (hora)" (sin distinguir mayúsculas).
 */
export function matchesBoardingPoint(stored: string, point: BoardingPointConfig): boolean {
  const normalizedStored = stored.trim().toLowerCase();
  return (
    normalizedStored === point.id.trim().toLowerCase() ||
    normalizedStored === point.location.trim().toLowerCase() ||
    normalizedStored === `${point.location} (${point.time})`.trim().toLowerCase()
  );
}

/** Devuelve el punto configurado que corresponde al valor guardado, o `null` si no hay coincidencia. */
export function findBoardingPoint<T extends BoardingPointConfig>(
  stored: string | null | undefined,
  points: readonly T[],
): T | null {
  if (!stored) return null;
  return points.find((point) => matchesBoardingPoint(stored, point)) ?? null;
}
