import { LODGING_ROOM_CAPACITY, type LodgingRoomType } from "../constants/domain.constants.js";

/**
 * Tipo que toma una habitación cuando su capacidad deja de coincidir con la de su tipo (regla 27).
 * Con 2 lugares no se asume pareja: Doble Individual.
 */
const ROOM_TYPE_BY_CAPACITY: Readonly<Record<number, LodgingRoomType>> = {
  1: "SINGLE",
  2: "DOUBLE_INDIVIDUAL",
  3: "TRIPLE",
  4: "QUADRUPLE",
};

/**
 * Tipo de habitación que corresponde a una capacidad (única regla; p. ej. al eliminar una cama).
 * Si la capacidad sigue siendo la del tipo actual, lo conserva (una Matrimonial de 2 sigue siendo
 * Matrimonial). Si no: 1 → SINGLE, 2 → DOUBLE_INDIVIDUAL, 3 → TRIPLE, 4 → QUADRUPLE. Una capacidad
 * fuera de 1..4 conserva el tipo actual.
 */
export function resolveRoomTypeForCapacity(
  currentType: LodgingRoomType,
  capacity: number,
): LodgingRoomType {
  if (LODGING_ROOM_CAPACITY[currentType] === capacity) return currentType;
  return ROOM_TYPE_BY_CAPACITY[capacity] ?? currentType;
}
