import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TourManifestService } from "./tour-manifest.service.js";

export async function tourManifestRoutes(app: FastifyInstance) {
  app.get(
    "/:tourId/",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ tourId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      try {
        const { tourId } = request.params as { tourId: string };
        const { agencyId } = request.user;
        const manifest = await TourManifestService.getTourManifest(agencyId, tourId);

        return reply.status(200).send({ data: manifest });
      } catch (error) {
        app.log.error(error, "Error generando manifiesto del tour");
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
