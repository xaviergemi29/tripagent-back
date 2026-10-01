import { z } from "zod";
import { CURRENCIES, TOUR_MODALITIES } from "../../db/schema.js";

const emptyToNull = z.preprocess(
  (val) => (typeof val === "string" && val.trim() === "" ? null : val),
  z.string().nullable().optional(),
);

export const getTourByIdParamsSchema = z.object({
  tourId: z.uuid("El ID del tour debe ser un UUID válido"),
});

export const baseTourSchema = z.object({
  title: z.string().trim().min(5, "El título debe tener al menos 5 caracteres").max(100),
  transportModality: z.enum(TOUR_MODALITIES.enumValues).default("TRANSPORT_INCLUDED"),
  price: z.number().positive("El precio debe ser mayor a 0"),
  currency: z.enum(CURRENCIES.enumValues).default("MXN"),
  depositPerPerson: z.number().min(0, "El anticipo no puede ser negativo").default(0),

  departureDateTime: z.string().min(10, "Formato YYYY-MM-DD requerido"),
  returnDate: emptyToNull,

  maxCapacity: z.number().int().positive("La capacidad debe ser de al menos 1 asiento"),
  isActive: z.boolean().default(true),

  acceptsBankTransfer: z.boolean().default(false),
  acceptsCreditCard: z.boolean().default(false),

  paymentLink: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? null : val),
    z.url("Debe ser una URL válida").nullable().optional(),
  ),

  acceptsCash: z.boolean().default(false),
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

  brochureUrl: emptyToNull,
});

function withPaymentRefinements<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((data: any, ctx) => {
    if (data.depositPerPerson > data.price) {
      ctx.addIssue({
        code: "custom",
        message: "El anticipo no puede ser mayor al precio total del tour",
        path: ["depositPerPerson"],
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

export const assignVehicleBodySchema = z.object({
  vehicleId: z.uuid("El ID del vehículo debe ser un UUID válido"),
});

export const createTourBodySchema = withPaymentRefinements(baseTourSchema);
export const updateTourBodySchema = withPaymentRefinements(baseTourSchema.partial()).extend({
  removeBrochure: z.boolean().optional(),
});

export const getToursQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().min(1).max(100).default(100),
  offset: z.coerce.number().min(0).default(0),
});

export type AssignVehicleBody = z.infer<typeof assignVehicleBodySchema>;
export type CreateTourBody = z.infer<typeof createTourBodySchema>;
export type UpdateTourBody = z.infer<typeof updateTourBodySchema>;
export type GetToursQuery = z.infer<typeof getToursQuerySchema>;
