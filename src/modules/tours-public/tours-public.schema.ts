import z from "zod";

export const getToursPublicParamsSchema = z.object({
  id: z.uuid("ID incorrecto"),
});
