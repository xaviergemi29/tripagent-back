import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
      schema: {
        body: updateSeatBodySchema,
        params: updateTourSeatsParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { tourId, seatLabel } = request.params;
        const { body } = request;
        const result = await TourSeatsService.updateSeatStatus(tourId, seatLabel, body);
        return reply.status(200).send({ data: result });
      } catch (error) {
        app.log.error(error, "Error actualizando asiento");
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.get(
    "/:tourId/seats",
    {
      schema: {
        params: getTourSeatsByIdParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { tourId } = request.params;
        const seats = await TourSeatsService.getTourSeats(tourId);
        return reply.status(200).send({ data: seats });
      } catch (error) {
        app.log.error(error, "Error consultando asientos del tour");
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
