import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  boardingPassengerParamsSchema,
  boardingTourParamsSchema,
  setBoardingBodySchema,
} from "./boarding.schema.js";
import { BoardingService } from "./boarding.service.js";

/**
 * Pase de lista de abordaje en el Centro de Control (RB-MAN-002). Prefijo: /api/tours. Con sesión:
 * el 402 del Modo Solo Lectura lo da `authenticate`; el Modo Auditoría, el servicio (409).
 */
export async function boardingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:tourId/boarding",
    { onRequest: [app.authenticate], schema: { params: boardingTourParamsSchema } },
    async (request, reply) => {
      const data = await BoardingService.getPanelList(request.params.tourId, request.user.agencyId);
      return reply.status(200).send({ data });
    },
  );

  server.patch(
    "/:tourId/passengers/:travelerId/boarding",
    {
      onRequest: [app.authenticate],
      schema: { params: boardingPassengerParamsSchema, body: setBoardingBodySchema },
    },
    async (request, reply) => {
      const tour = await BoardingService.findAgencyTour(
        request.params.tourId,
        request.user.agencyId,
      );
      const updated = await BoardingService.setBoarding(
        tour,
        { travelerId: request.params.travelerId },
        request.body.boarded,
        request.user.id,
      );
      return reply.status(200).send({
        data: { travelerId: updated.travelerId, boardedAt: updated.boardedAt ?? null },
      });
    },
  );
}
