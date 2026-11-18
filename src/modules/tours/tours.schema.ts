import { z } from "zod";
import { isPastDate, PAST_DEPARTURE_ERROR } from "../../shared/utils/mexico-date.util.js";
import { CURRENCIES, DESTINATION_TYPE, TOUR_MODALITIES } from "../../db/schema.js";
import {
  TOUR_CANCELLATION_NOTE_MAX_LENGTH,
  TOUR_CANCELLATION_REASONS,
} from "../../shared/constants/domain.constants.js";

const emptyToNull = z.preprocess(
  (val) => (typeof val === "string" && val.trim() === "" ? null : val),
  z.string().nullable().optional(),
);

export const getTourByIdParamsSchema = z.object({
  tourId: z.uuid("El ID del tour debe ser un UUID válido"),
});

/**
 * Campos del tour SIN valores por defecto. En Zod 4 un `.default()` se aplica también dentro de
 * `.partial()`, así que un PATCH parcial (p. ej. `{ title }`) reescribía la moneda, el
 * anticipo y los métodos de cobro. Los defaults solo se aplican al crear (`createTourBodySchema`).
 */
export const baseTourSchema = z.object({
  title: z.string().trim().min(5, "El título debe tener al menos 5 caracteres").max(100),
  // Texto libre del folleto e instrucciones tras pagar. La BD no acepta null: null → "".
  description: z.preprocess(
    (val) => (val === null ? "" : val),
    z.string().trim().max(5000, "La descripción no puede superar 5000 caracteres"),
  ),
  postPaymentInstructions: z.preprocess(
    (val) => (val === null ? "" : val),
    z.string().trim().max(2000, "Las instrucciones no pueden superar 2000 caracteres"),
  ),
  destinationType: z.enum(DESTINATION_TYPE.enumValues),
  transportModality: z.enum(TOUR_MODALITIES.enumValues),
  price: z.number().positive("El precio debe ser mayor a 0"),
  currency: z.enum(CURRENCIES.enumValues),
  depositPerPerson: z.number().min(0, "El anticipo no puede ser negativo"),

  departureDateTime: z.string().min(10, "Formato YYYY-MM-DD requerido"),
  returnDate: emptyToNull,

  maxCapacity: z.number().int().positive("La capacidad debe ser de al menos 1 asiento"),
  staffCapacity: z
    .number()
    .int("Los lugares de staff deben ser un número entero")
    .min(0, "Los lugares de staff no pueden ser negativos")
    .optional(),
  // Sin `isActive`: "Pausado" no existe en el MVP (decisión del PM, 2026-11-14). Un tour se cancela
  // con `POST /tours/:id/cancel`; un `isActive` enviado se descarta.

  acceptsBankTransfer: z.boolean(),
  acceptsCreditCard: z.boolean(),

  paymentLink: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? null : val),
    z.url("Debe ser una URL válida").nullable().optional(),
  ),

  acceptsCash: z.boolean(),
  cashInstructions: emptyToNull,

  boardingPoints: z
    .array(
      z.object({
        id: z.uuid("ID inválido").default(() => crypto.randomUUID()),
        location: z.string().min(3, "La ubicación es requerida"),
        time: z.string().regex(/^([01]\d|2[0-3]):?([0-5]\d)$/, "Formato HH:MM"),
      }),
    )
    .min(1, "Debes agregar al menos un punto de abordaje"),

  // Sin `brochureUrl` (auditoría 2026-11-15): solo lo escribe `POST /tours/:id/brochure`. Antes era
  // editable por el cuerpo y, como el folleto público expone el `brochureUrl` de cualquier tour, una
  // agencia podía apuntar su tour al PDF de otra y borrarlo con `removeBrochure`. Si el cliente lo
  // sigue enviando, Zod lo descarta.
});

export const STAFF_CAPACITY_ERROR = "Los lugares de staff deben ser menores a la capacidad total";
export const FROZEN_PRICING_ERROR =
  "No se puede cambiar la moneda ni el precio por pasajero: el tour ya tiene pagos registrados";

/** Campos que leen los refinamientos (en el PATCH parcial todos pueden faltar). */
interface TourRefinementInput {
  maxCapacity?: number | undefined;
  staffCapacity?: number | undefined;
  depositPerPerson?: number | undefined;
  price?: number | undefined;
  acceptsBankTransfer?: boolean | undefined;
  acceptsCreditCard?: boolean | undefined;
  paymentLink?: string | null | undefined;
  acceptsCash?: boolean | undefined;
  cashInstructions?: string | null | undefined;
}

/**
 * Al menos un método de cobro activo (OBS-038, decisión del PM, 2026-11-17). Mismo texto que el
 * formulario del front. La transferencia cuenta aunque la agencia aún no tenga CLABE: el tour se
 * puede guardar y el Magic Link ofrece pedir los datos por WhatsApp.
 */
export const PAYMENT_METHOD_REQUIRED_ERROR =
  "Debes habilitar al menos un método de cobro para tus viajeros";

export const hasAnyPaymentMethod = (methods: {
  acceptsBankTransfer?: boolean | null | undefined;
  acceptsCreditCard?: boolean | null | undefined;
  acceptsCash?: boolean | null | undefined;
}): boolean =>
  Boolean(methods.acceptsBankTransfer || methods.acceptsCreditCard || methods.acceptsCash);

function withTourRefinements<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((raw: unknown, ctx) => {
    const data = raw as TourRefinementInput;
    if (
      data.maxCapacity !== undefined &&
      data.staffCapacity !== undefined &&
      data.staffCapacity >= data.maxCapacity
    ) {
      ctx.addIssue({
        code: "custom",
        message: STAFF_CAPACITY_ERROR,
        path: ["staffCapacity"],
      });
    }

    if (
      data.depositPerPerson !== undefined &&
      data.price !== undefined &&
      data.depositPerPerson > data.price
    ) {
      ctx.addIssue({
        code: "custom",
        message: "El anticipo no puede ser mayor al precio total del tour",
        path: ["depositPerPerson"],
      });
    }

    // Solo cuando llegan los tres (crear: con sus valores por defecto). En un PATCH parcial lo valida
    // `TourService.updateTour` combinando lo enviado con lo guardado.
    if (
      data.acceptsBankTransfer !== undefined &&
      data.acceptsCreditCard !== undefined &&
      data.acceptsCash !== undefined &&
      !hasAnyPaymentMethod(data)
    ) {
      ctx.addIssue({
        code: "custom",
        message: PAYMENT_METHOD_REQUIRED_ERROR,
        path: ["acceptsBankTransfer"],
      });
    }

    if (data.acceptsCreditCard && (!data.paymentLink || data.paymentLink === "")) {
      ctx.addIssue({
        code: "custom",
        message: "Debes proporcionar un enlace de pago si aceptas tarjeta",
        path: ["paymentLink"],
      });
    }

    if (data.acceptsCash && (!data.cashInstructions || data.cashInstructions.trim().length < 10)) {
      ctx.addIssue({
        code: "custom",
        message: "Instrucciones claras son necesarias para pagos en efectivo",
        path: ["cashInstructions"],
      });
    }
  });
}

// Se asigna una unidad de la agencia (`vehicleId`) o una plantilla del catálogo (`templateId`, la API
// crea o reutiliza la unidad de la agencia para esa plantilla). Exactamente uno de los dos.
// `resetOrphans` ya no existe: al cambiar de vehículo SIEMPRE se liberan los asientos y bloqueos
// cuya etiqueta no existe en el nuevo croquis. Si un cliente lo sigue enviando, Zod lo descarta.
export const assignVehicleBodySchema = z
  .object({
    vehicleId: z.uuid("El ID del vehículo debe ser un UUID válido").optional(),
    templateId: z.uuid("El ID de la plantilla debe ser un UUID válido").optional(),
  })
  .refine((body) => (body.vehicleId ? 1 : 0) + (body.templateId ? 1 : 0) === 1, {
    message: "Envía vehicleId o templateId (solo uno)",
  });

export const createTourBodySchema = withTourRefinements(
  baseTourSchema.extend({
    description: baseTourSchema.shape.description.optional(),
    postPaymentInstructions: baseTourSchema.shape.postPaymentInstructions.optional(),
    destinationType: baseTourSchema.shape.destinationType.default("NATIONAL"),
    transportModality: baseTourSchema.shape.transportModality.default("TRANSPORT_INCLUDED"),
    currency: baseTourSchema.shape.currency.default("MXN"),
    depositPerPerson: baseTourSchema.shape.depositPerPerson.default(0),
    acceptsBankTransfer: baseTourSchema.shape.acceptsBankTransfer.default(false),
    acceptsCreditCard: baseTourSchema.shape.acceptsCreditCard.default(false),
    acceptsCash: baseTourSchema.shape.acceptsCash.default(false),
  }),
  // Un tour nuevo no sale en el pasado (2026-11-17): con un año mal elegido nacía FINALIZADO.
).refine((body) => !isPastDate(body.departureDateTime), {
  path: ["departureDateTime"],
  message: PAST_DEPARTURE_ERROR,
});
export const updateTourBodySchema = withTourRefinements(baseTourSchema.partial()).extend({
  removeBrochure: z.boolean().optional(),
});

/**
 * Cancelación del tour por la agencia (decisión del PM, 2026-11-14): motivo de una lista fija y
 * nota interna opcional (≤ 200; vacía → null).
 */
export const cancelTourBodySchema = z.object({
  reason: z.enum(TOUR_CANCELLATION_REASONS, "Selecciona el motivo de la cancelación"),
  note: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? null : val),
    z
      .string()
      .trim()
      .max(
        TOUR_CANCELLATION_NOTE_MAX_LENGTH,
        `La nota admite máximo ${TOUR_CANCELLATION_NOTE_MAX_LENGTH} caracteres`,
      )
      .nullable()
      .optional(),
  ),
});

export const getToursQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().min(1).max(100).default(100),
  offset: z.coerce.number().min(0).default(0),
});

export type CreateTourBody = z.infer<typeof createTourBodySchema>;
export type UpdateTourBody = z.infer<typeof updateTourBodySchema>;
export type GetToursQuery = z.infer<typeof getToursQuerySchema>;
export type CancelTourBody = z.infer<typeof cancelTourBodySchema>;
