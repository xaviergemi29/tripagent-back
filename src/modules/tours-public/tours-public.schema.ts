import z from "zod";

export const getToursPublicParamsSchema = z.object({
  id: z.uuid("ID incorrecto"),
});

export type GetToursPublic = z.infer<typeof getToursPublicParamsSchema>;
