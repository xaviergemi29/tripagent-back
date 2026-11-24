import z from "zod";
import {
  LODGING_ROOM_STATUSES,
  LODGING_ROOM_TYPES,
} from "../../shared/constants/domain.constants.js";
import {
  getRoomBedsError,
  LEGACY_ROOM_TYPE_BEDS,
  LODGING_BED_LIMITS,
} from "../../shared/utils/lodging-room.util.js";

/** Máximo de habitaciones de una misma configuración por envío (contador del modal). */
export const LODGING_MAX_ROOMS_PER_TYPE = 50;
/** Máximo de configuraciones de camas por envío. */
export const LODGING_MAX_ROOM_CONFIGS_PER_REQUEST = 20;
/** Máximo de habitaciones por envío (suma de todas las configuraciones). */
export const LODGING_MAX_ROOMS_PER_REQUEST = 200;
export const LODGING_HOTEL_NAME_MAX_LENGTH = 120;
/** Largo máximo del número de cuarto que asigna el hotel (columna varchar(10)). */
export const LODGING_ROOM_NUMBER_MAX_LENGTH = 10;
/** Lugares que se asignan en un solo envío (la habitación más grande es para 6). */
export const LODGING_MAX_ASSIGNMENTS_PER_REQUEST = LODGING_BED_LIMITS.maxCapacity;

export const lodgingTourParamsSchema = z.object({
  tourId: z.uuid("El ID del tour debe ser un UUID válido"),
});

const bedCountSchema = (label: string) =>
  z.number(`Las camas ${label} deben ser un número`).int(`Las camas ${label} deben ser un entero`);

/**
 * Configuración de camas y cuántas habitaciones crear con ella. La capacidad y el tipo heredado
 * NO viajan: los decide el servidor. Configuraciones repetidas se permiten (se crean en orden).
 */
const roomBatchSchema = z
  .object({
    matrimonialBeds: bedCountSchema("matrimoniales"),
    singleBeds: bedCountSchema("individuales"),
    quantity: z
      .number("La cantidad debe ser un número")
      .int("La cantidad debe ser un número entero")
      .min(1, "La cantidad mínima es 1")
      .max(LODGING_MAX_ROOMS_PER_TYPE, `La cantidad máxima es ${LODGING_MAX_ROOMS_PER_TYPE}`),
  })
  .superRefine((room, ctx) => {
    const error = getRoomBedsError(room);
    if (error) ctx.addIssue({ code: "custom", message: error });
  });

/**
 * Compatibilidad con clientes anteriores: `{ roomType, quantity }` (sin camas) se traduce a las
 * camas del tipo heredado. Si llega cualquier campo de camas, manda el formato nuevo.
 */
const legacyRoomBatchToBeds = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  if ("matrimonialBeds" in value || "singleBeds" in value) return value;
  if (!("roomType" in value)) return value;
  const roomType = LODGING_ROOM_TYPES.find((type) => type === value.roomType);
  if (!roomType) return value;
  return { ...value, ...LEGACY_ROOM_TYPE_BEDS[roomType] };
};

/** Lote de habitaciones de un hotel. Claves extra (p. ej. `capacity`) se descartan. */
export const createLodgingRoomsBodySchema = z
  .object({
    hotelName: z
      .string("El nombre del hotel es obligatorio")
      .trim()
      .min(1, "El nombre del hotel es obligatorio")
      .max(
        LODGING_HOTEL_NAME_MAX_LENGTH,
        `El nombre del hotel no debe superar ${LODGING_HOTEL_NAME_MAX_LENGTH} caracteres`,
      ),
    rooms: z
      .array(
        z.preprocess(legacyRoomBatchToBeds, roomBatchSchema),
        "Indica las habitaciones a crear",
      )
      .min(1, "Agrega al menos una habitación")
      .max(
        LODGING_MAX_ROOM_CONFIGS_PER_REQUEST,
        `No se pueden enviar más de ${LODGING_MAX_ROOM_CONFIGS_PER_REQUEST} configuraciones a la vez`,
      ),
  })
  .superRefine((body, ctx) => {
    const total = body.rooms.reduce((sum, room) => sum + room.quantity, 0);
    if (total > LODGING_MAX_ROOMS_PER_REQUEST) {
      ctx.addIssue({
        code: "custom",
        path: ["rooms"],
        message: `No se pueden crear más de ${LODGING_MAX_ROOMS_PER_REQUEST} habitaciones a la vez`,
      });
    }
  });

export const lodgingRoomParamsSchema = lodgingTourParamsSchema.extend({
  roomId: z.uuid("El ID de la habitación debe ser un UUID válido"),
});

export const lodgingSlotParamsSchema = lodgingRoomParamsSchema.extend({
  slotIndex: z.coerce
    .number("La cama debe ser un número")
    .int("La cama debe ser un número entero")
    .min(1, "La cama mínima es 1"),
});

/** Número de cuarto: se recorta; vacío → null (quitar el número). */
const roomNumberSchema = z
  .string("El número de cuarto debe ser texto")
  .trim()
  .max(
    LODGING_ROOM_NUMBER_MAX_LENGTH,
    `El número de cuarto no debe superar ${LODGING_ROOM_NUMBER_MAX_LENGTH} caracteres`,
  )
  .nullable()
  .transform((value) => (value ? value : null));

export const updateLodgingRoomBodySchema = z
  .object({
    roomNumber: roomNumberSchema.optional(),
    status: z.enum(LODGING_ROOM_STATUSES, "Estado de habitación inválido").optional(),
  })
  .refine((body) => body.roomNumber !== undefined || body.status !== undefined, {
    message: "Indica el número de cuarto o el estado de la habitación",
  });

const assignmentSchema = z.object({
  slotIndex: z
    .number("La cama debe ser un número")
    .int("La cama debe ser un número entero")
    .min(1, "La cama mínima es 1")
    .max(LODGING_BED_LIMITS.maxCapacity, `La cama máxima es ${LODGING_BED_LIMITS.maxCapacity}`),
  bookingPassengerId: z.uuid("El ID del pasajero debe ser un UUID válido"),
});

export const assignLodgingSlotsBodySchema = z
  .object({
    assignments: z
      .array(assignmentSchema, "Indica las camas a asignar")
      .min(1, "Asigna al menos una cama")
      .max(
        LODGING_MAX_ASSIGNMENTS_PER_REQUEST,
        `No se pueden asignar más de ${LODGING_MAX_ASSIGNMENTS_PER_REQUEST} camas a la vez`,
      ),
  })
  .superRefine((body, ctx) => {
    const slots = body.assignments.map((item) => item.slotIndex);
    if (new Set(slots).size !== slots.length) {
      ctx.addIssue({
        code: "custom",
        path: ["assignments"],
        message: "Cada cama solo puede aparecer una vez",
      });
    }
    const passengers = body.assignments.map((item) => item.bookingPassengerId);
    if (new Set(passengers).size !== passengers.length) {
      ctx.addIssue({
        code: "custom",
        path: ["assignments"],
        message: "Cada pasajero solo puede aparecer una vez",
      });
    }
  });

export type LodgingTourParams = z.infer<typeof lodgingTourParamsSchema>;
export type CreateLodgingRoomsBody = z.infer<typeof createLodgingRoomsBodySchema>;
export type UpdateLodgingRoomBody = z.infer<typeof updateLodgingRoomBodySchema>;
export type AssignLodgingSlotsBody = z.infer<typeof assignLodgingSlotsBodySchema>;
