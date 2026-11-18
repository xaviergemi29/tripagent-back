import type { FastifyInstance } from "fastify";
import { TourSeatsService } from "./tour-seats.service.js";
import {
  getTourSeatsByIdParamSchema,
  updateSeatBodySchema,
  updateTourSeatsParamsSchema,
} from "./tour-seats.schema.js";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

export async function tourSeatsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.patch(
    "/:tourId/seats/:seatLabel",
    {
      onRequest: [app.authenticate],
      schema: {
        body: updateSeatBodySchema,
        params: updateTourSeatsParamsSchema,
      },
    },
    async (request, reply) => {
      const { tourId, seatLabel } = request.params;
      const { body } = request;
      const { agencyId, id: userId } = request.user;
      const result = await TourSeatsService.updateSeatStatus(
        tourId,
        seatLabel,
        body,
        agencyId,
        userId,
      );
      return reply.status(200).send({ data: result });
    },
  );

  server.get(
    "/:tourId/seats",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTourSeatsByIdParamSchema,
      },
    },
    async (request, reply) => {
      const { tourId } = request.params;
      const { agencyId } = request.user;
      const seats = await TourSeatsService.getTourSeats(tourId, agencyId);
      return reply.status(200).send({ data: seats });
    },
  );
}
