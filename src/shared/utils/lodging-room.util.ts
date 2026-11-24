import { LODGING_ROOM_TYPES, type LodgingRoomType } from "../constants/domain.constants.js";

/**
 * Camas de una habitación (regla 27). La ocupación (personas) se DERIVA de las camas: una cama
 * matrimonial da 2 lugares y una individual 1. Única fuente de las reglas de camas.
 */
export interface RoomBeds {
  matrimonialBeds: number;
  singleBeds: number;
}

/** Límites de camas por habitación (espejo en el front). */
export const LODGING_BED_LIMITS = {
  maxMatrimonialBeds: 2,
  maxSingleBeds: 4,
  /** Personas por habitación: 2 · matrimoniales + individuales. */
  maxCapacity: 6,
} as const;

/**
 * Camas de los tipos heredados (dato anterior a las camas; columna `room_type`). Con 2 lugares sin
 * pareja: Doble Individual. Triple = 1 matrimonial + 1 individual; Cuádruple = 2 matrimoniales.
 */
export const LEGACY_ROOM_TYPE_BEDS = {
  SINGLE: { matrimonialBeds: 0, singleBeds: 1 },
  MATRIMONIAL: { matrimonialBeds: 1, singleBeds: 0 },
  DOUBLE_INDIVIDUAL: { matrimonialBeds: 0, singleBeds: 2 },
  TRIPLE: { matrimonialBeds: 1, singleBeds: 1 },
  QUADRUPLE: { matrimonialBeds: 2, singleBeds: 0 },
} as const satisfies Record<LodgingRoomType, RoomBeds>;

/** Personas que caben en la habitación: 2 · matrimoniales + individuales. */
export const getRoomCapacity = ({ matrimonialBeds, singleBeds }: RoomBeds): number =>
  2 * matrimonialBeds + singleBeds;

/**
 * Motivo por el que una combinación de camas no es válida, o `null` si lo es: enteros, matrimoniales
 * 0..2, individuales 0..4, al menos una cama y capacidad ≤ 6.
 */
export function getRoomBedsError(beds: RoomBeds): string | null {
  const { matrimonialBeds, singleBeds } = beds;
  if (!Number.isInteger(matrimonialBeds) || !Number.isInteger(singleBeds)) {
    return "El número de camas debe ser un entero";
  }
  if (matrimonialBeds < 0 || matrimonialBeds > LODGING_BED_LIMITS.maxMatrimonialBeds) {
    return `Las camas matrimoniales deben ser de 0 a ${LODGING_BED_LIMITS.maxMatrimonialBeds}`;
  }
  if (singleBeds < 0 || singleBeds > LODGING_BED_LIMITS.maxSingleBeds) {
    return `Las camas individuales deben ser de 0 a ${LODGING_BED_LIMITS.maxSingleBeds}`;
  }
  if (matrimonialBeds + singleBeds < 1) return "La habitación debe tener al menos una cama";
  if (getRoomCapacity(beds) > LODGING_BED_LIMITS.maxCapacity) {
    return `La habitación no puede ser para más de ${LODGING_BED_LIMITS.maxCapacity} personas`;
  }
  return null;
}

export type BedKind = "MATRIMONIAL" | "SINGLE";

export interface RoomBed {
  kind: BedKind;
  /** Número de la cama dentro de su clase (1..n). */
  bedIndex: number;
  /** Lugares (`slotIndex`) que ocupa la cama, consecutivos y ascendentes. */
  slots: number[];
}

/**
 * Cama que contiene el lugar `slotIndex` (1..capacidad). Disposición: primero las matrimoniales, cada
 * una con 2 lugares consecutivos (cama i → lugares 2i−1 y 2i), después las individuales (1 lugar
 * cada una). Lugar fuera de la capacidad → `null`.
 */
export function getBedOfSlot(beds: RoomBeds, slotIndex: number): RoomBed | null {
  if (!Number.isInteger(slotIndex) || slotIndex < 1 || slotIndex > getRoomCapacity(beds)) {
    return null;
  }
  const matrimonialSlots = 2 * beds.matrimonialBeds;
  if (slotIndex <= matrimonialSlots) {
    const bedIndex = Math.ceil(slotIndex / 2);
    return { kind: "MATRIMONIAL", bedIndex, slots: [2 * bedIndex - 1, 2 * bedIndex] };
  }
  return { kind: "SINGLE", bedIndex: slotIndex - matrimonialSlots, slots: [slotIndex] };
}

/** Camas que quedan al quitar una cama de la clase indicada. */
export const withoutBed = (beds: RoomBeds, kind: BedKind): RoomBeds =>
  kind === "MATRIMONIAL"
    ? { matrimonialBeds: beds.matrimonialBeds - 1, singleBeds: beds.singleBeds }
    : { matrimonialBeds: beds.matrimonialBeds, singleBeds: beds.singleBeds - 1 };

/**
 * Tipo heredado que corresponde EXACTAMENTE a esas camas (las 5 combinaciones de
 * `LEGACY_ROOM_TYPE_BEDS`), o `null` si no hay ninguno (p. ej. 3 individuales).
 */
export function legacyRoomTypeForBeds(beds: RoomBeds): LodgingRoomType | null {
  return (
    LODGING_ROOM_TYPES.find(
      (type) =>
        LEGACY_ROOM_TYPE_BEDS[type].matrimonialBeds === beds.matrimonialBeds &&
        LEGACY_ROOM_TYPE_BEDS[type].singleBeds === beds.singleBeds,
    ) ?? null
  );
}
