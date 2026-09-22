import z from "zod";

export const getTourManifestByIdParamsSchema = z.object({ tourId: z.uuid() });
