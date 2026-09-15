import { z } from "zod";

export const validateTokenParamsSchema = z.object({
    token: z.string().min(1, "El token no puede estar vacío"),
});


export const tourResponseSchema = z.object({
    id: z.uuid(),
    title: z.string(),
    boardingPoints: z.array(
        z.object({
            id: z.uuid("ID inválido").default(() => crypto.randomUUID()),
            location: z.string().min(3, "La ubicación es requerida"),
            time: z.string().regex(/^([01]\d|2[0-3]):?([0-5]\d)$/, "Formato HH:MM"),
        })
    )
})

export const tokenValidationResponseSchema = z.object({
    isValid: z.boolean(),
    data: z.object({
        availableSeats: z.number(),
        tour: tourResponseSchema
    }).optional(),
    error: z.object({
        code: z.enum(["NOT_FOUND", "EXPIRED", "CAPACITY_REACHED"]),
        message: z.string()
    }).optional()
});