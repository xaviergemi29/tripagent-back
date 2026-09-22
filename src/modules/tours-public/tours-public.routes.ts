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
        return reply.status(200).send(tourBrochure);
      } catch (error) {
        app.log.error(error, "Error al obtener el folleto público");

        if (error instanceof Error) return reply.status(500).send({ error: error.message });

        if (error instanceof Error && error.message === "Tour no encontrado") {
          return reply.status(404).send({ error: error.message });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
