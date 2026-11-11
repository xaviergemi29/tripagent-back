import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getToursPublicParamsSchema } from "./tours-public.schema.js";
import { TourBrochure } from "./tours-public.service.js";

export async function tourBrochureRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/public/tours/:id",
    {
      schema: {
        params: getToursPublicParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const tourBrochure = await TourBrochure.findTourBrochureById(id);

        if (!tourBrochure) {
          return reply.status(404).send({ error: "Tour no encontrado" });
        }

        return reply.status(200).send(tourBrochure);
      } catch (error) {
        app.log.error(error, "Error al obtener el folleto público");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
