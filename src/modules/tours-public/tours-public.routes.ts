import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getToursPublicParamsSchema } from "./tours-public.schema.js";
import { TourBrochure } from "./tours-public.service.js";
import { RATE_LIMITS } from "../../shared/security/rate-limits.js";

export async function tourBrochureRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/public/tours/:id",
    {
      config: { rateLimit: RATE_LIMITS.publicRead },
      schema: {
        params: getToursPublicParamsSchema,
      },
    },
    async (request, reply) => {
      const tourBrochure = await TourBrochure.findTourBrochureById(request.params.id);
      if (!tourBrochure) return reply.status(404).send({ error: "Tour no encontrado" });
      return reply.status(200).send(tourBrochure);
    },
  );
}
