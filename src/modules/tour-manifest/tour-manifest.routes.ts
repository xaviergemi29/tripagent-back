import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { TourManifestService } from "./tour-manifest.service.js";
import { getTourManifestByIdParamsSchema } from "./tour-manifest.schema.js";

/** Manifiesto de abordaje. Prefijo: /api/manifest. 404 si el tour no es de la agencia. */
export async function tourManifestRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:tourId/",
    { onRequest: [app.authenticate], schema: { params: getTourManifestByIdParamsSchema } },
    async (request, reply) => {
      const manifest = await TourManifestService.getTourManifest(
        request.user.agencyId,
        request.params.tourId,
      );
      return reply.status(200).send({ data: manifest });
    },
  );
}
