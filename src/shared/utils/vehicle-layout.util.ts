import { z } from "zod";

/**
 * Croquis de un vehículo (`layoutMap`): matriz de filas × columnas, de adelante hacia atrás.
 *
 * Cada celda es una de estas (formato 2026-11-12; las celdas de texto son el formato anterior y
 * siguen siendo válidas, así que los vehículos existentes no requieren migración de datos):
 * - `null` → espacio vacío (o celda cubierta por un WC que se extiende con `rowSpan`/`colSpan`).
 * - `"AISLE"` → pasillo.
 * - cualquier otro texto → asiento de pasajero con esa etiqueta (formato anterior).
 * - `{ type: "SEAT", label, kind }` → asiento; `kind = "STAFF"` lo reserva para el staff.
 * - `{ type: "DRIVER" }` → operador (chofer). Nunca cuenta como asiento.
 * - `{ type: "WC", rowSpan?, colSpan? }` → baño. No cuenta como asiento.
 */
export const SEAT_KINDS = ["PASSENGER", "STAFF"] as const;
export type SeatKind = (typeof SEAT_KINDS)[number];

const seatLabelSchema = z
  .string()
  .trim()
  .min(1, "La etiqueta del asiento no puede estar vacía")
  .max(10, "La etiqueta del asiento admite máximo 10 caracteres")
  .refine((label) => label !== "AISLE", "AISLE está reservado para el pasillo");

const spanSchema = z.number().int().min(1).max(4).optional();

export const layoutCellSchema = z.union([
  z.null(),
  z.string().trim().min(1).max(10), // "AISLE" o etiqueta de asiento de pasajero (formato anterior)
  z.object({
    type: z.literal("SEAT"),
    label: seatLabelSchema,
    kind: z.enum(SEAT_KINDS).default("PASSENGER"),
  }),
  z.object({ type: z.literal("DRIVER") }),
  z.object({ type: z.literal("WC"), rowSpan: spanSchema, colSpan: spanSchema }),
]);

export const layoutMapSchema = z
  .array(z.array(layoutCellSchema).min(1))
  .min(1, "El croquis debe tener al menos una fila")
  .superRefine((layoutMap, ctx) => {
    const labels = getLayoutSeats(layoutMap).map((seat) => seat.label);
    const duplicated = labels.filter((label, index) => labels.indexOf(label) !== index);
    if (duplicated.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `Etiquetas de asiento repetidas: ${[...new Set(duplicated)].join(", ")}`,
      });
    }
    if (labels.length === 0) {
      ctx.addIssue({ code: "custom", message: "El croquis debe tener al menos un asiento" });
    }
  });

export type LayoutCell = z.input<typeof layoutCellSchema> | undefined;
export type LayoutMap = LayoutCell[][];

export interface LayoutSeat {
  label: string;
  kind: SeatKind;
  row: number;
  col: number;
}

/** Asiento de la celda, o null si la celda no es un asiento (vacío, pasillo, operador, WC). */
export const getSeatFromCell = (cell: LayoutCell): Omit<LayoutSeat, "row" | "col"> | null => {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "string") return cell === "AISLE" ? null : { label: cell, kind: "PASSENGER" };
  if (cell.type === "SEAT") return { label: cell.label, kind: cell.kind ?? "PASSENGER" };
  return null;
};

/** Todos los asientos del croquis (pasajeros y staff), en orden de lectura. */
export const getLayoutSeats = (layoutMap: LayoutMap): LayoutSeat[] =>
  layoutMap.flatMap((row, rowIndex) =>
    row.flatMap((cell, colIndex) => {
      const seat = getSeatFromCell(cell);
      return seat ? [{ ...seat, row: rowIndex, col: colIndex }] : [];
    }),
  );

/** Etiquetas de TODOS los asientos reales (pasajeros + staff). El operador y el WC no cuentan. */
export const getLayoutSeatLabels = (layoutMap: LayoutMap): string[] =>
  getLayoutSeats(layoutMap).map((seat) => seat.label);

export interface VehicleCapacity {
  /** Asientos físicos (pasajeros + staff). Excluye al operador. */
  total: number;
  /** Asientos que se pueden asignar a pasajeros. */
  passenger: number;
  /** Asientos reservados para staff por el croquis (p. ej. el copiloto de la Sprinter). */
  staff: number;
}

/** Única regla de capacidad de un vehículo (regla 8 de CLAUDE.md). */
export const getVehicleCapacity = (layoutMap: LayoutMap): VehicleCapacity => {
  const seats = getLayoutSeats(layoutMap);
  const staff = seats.filter((seat) => seat.kind === "STAFF").length;
  return { total: seats.length, passenger: seats.length - staff, staff };
};
