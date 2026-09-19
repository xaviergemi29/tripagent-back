import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AGENCY_ID } from "../../constants.js";
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
        const tourBrochure = await TourBrochure.findTourBrochureById(request.params.id, AGENCY_ID);
        reply.status(200).send(tourBrochure);
      } catch (error) {
        // ✅ 1. Loguear para el backend (esencial en Node.js)
        app.log.error(error, "Error al obtener el dashboard");

        // ✅ 2. Mapear el error a un código HTTP correcto
        if (error.message === "Tour no encontrado") {
          return reply.status(404).send({ error: error.message });
        }

        // ✅ 3. Error genérico
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
