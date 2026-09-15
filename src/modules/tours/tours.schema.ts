import { z } from "zod";
import { TOUR_MODALITIES } from "../../db/schema.js";

// Params Schema (UUID v4 explícito)
export const getTourByIdParamsSchema = z.object({
  id: z.uuid({
    version: "v4",
    message: "El ID del tour debe ser un UUID válido",
  }),
});

// 1. Definición del ZodObject puro (Permite metaprogramación de Zod como .partial(), .pick(), .omit())
export const baseTourSchema = z.object({
  title: z.string().trim().min(5, "El título debe tener al menos 5 caracteres").max(100),
  // description: z.string().trim().min(20, "Añade una descripción operativa"),
  // tourRecommendations: z
  //   .string()
  //   .trim()
  //   .min(10, "Menciona qué llevar (ropa, calzado, etc.)"),
  transportModality: z.enum(TOUR_MODALITIES.enumValues).default("TRANSPORT_INCLUDED"),
  price: z.number().positive("El precio debe ser mayor a 0"),
  // durationHours: z.number().int().positive("La duración debe ser de al menos 1 hora"),
  // meetingPoint: z.string().trim().min(5, "Punto de encuentro requerido"),
  departureDateTime: z.iso.date("Debe ser formato YYYY-MM-DD"),
  maxCapacity: z.number().int().positive("La capacidad debe ser de al menos 1 asiento"),
  isActive: z.boolean().default(true),

  // Configuración de Cobro
  acceptsBankTransfer: z.boolean().default(false),
  bankDetails: z.string().optional(),
  acceptsCreditCard: z.boolean().default(true),
  paymentLink: z.union([z.literal(""), z.url("Debe ser una URL válida")]).optional(),
  // postPaymentInstructions: z
  //   .string()
  //   .trim()
  //   .min(10, "Instrucciones de pago requeridas"),
  acceptsCash: z.boolean().default(false),
  cashInstructions: z.string().optional(),

  boardingPoints: z
    .array(
      z.object({
        id: z.uuid("ID inválido").default(() => crypto.randomUUID()),
        location: z.string().min(3, "La ubicación es requerida"),
        time: z.string().regex(/^([01]\d|2[0-3]):?([0-5]\d)$/, "Formato HH:MM"),
      }),
    )
    .min(1, "Debes agregar al menos un punto de abordaje"),
});

// 2. Refinamiento encapsulado
function withPaymentRefinements<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((data: any, ctx) => {
    if (data.acceptsBankTransfer && (!data.bankDetails || data.bankDetails.trim().length < 15)) {
      ctx.addIssue({
        code: "custom",
        message: "Proporciona Banco, CLABE y Titular (min. 15 caracteres)",
        path: ["bankDetails"],
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

// 3. Esquemas finales exportados
export const createTourBodySchema = withPaymentRefinements(baseTourSchema);
export const updateTourBodySchema = withPaymentRefinements(baseTourSchema.partial());

export const getToursQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().min(1).max(100).default(100),
  offset: z.coerce.number().min(0).default(0),
});

// Tipos de TypeScript inferidos
export type CreateTourBody = z.infer<typeof createTourBodySchema>;
export type UpdateTourBody = z.infer<typeof updateTourBodySchema>;
export type GetToursQuery = z.infer<typeof getToursQuerySchema>;
