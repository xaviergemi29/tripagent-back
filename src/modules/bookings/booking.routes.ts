import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  cancelBookingBodySchema,
  cancelBookingParamsSchema,
  createBookingBodySchema,
  newReservationBookingSchema,
  tourByIdParamsSchema,
} from "./booking.schema.js";
import { BookingService } from "./booking.service.js";

export async function bookingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  (server.post(
    "/",
    {
      onRequest: [app.authenticate],
      schema: {
        body: createBookingBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const booking = await BookingService.processGroupBooking(request.body, agencyId);
        if (!booking) {
          return reply.status(400).send({ error: "Booking no procesado" });
        }
        return reply.status(201).send(booking);
      } catch (error) {
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
      }
    },
  ),
    server.post(
      "/:id/quick-booking",
      {
        onRequest: [app.authenticate],
        schema: {
          body: newReservationBookingSchema,
          params: tourByIdParamsSchema,
        },
      },
      async (request, reply) => {
        try {
          const { agencyId } = request.user;
          const result = await BookingService.createQuickBooking(
            request.params.id,
            request.body,
            agencyId,
          );
          return reply.status(201).send({ success: true, data: result });
        } catch (error) {
          app.log.error(error, "Error en quick-booking");
          if (error instanceof Error) return reply.status(500).send({ error: error?.message });
        }
      },
    ));

  server.patch(
    "/:id/cancel",
    {
      onRequest: [app.authenticate],
      schema: {
        params: cancelBookingParamsSchema,
        body: cancelBookingBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const { penaltyPercentage } = request.body;
        const { agencyId } = request.user;
        const result = await BookingService.cancelBooking(id, penaltyPercentage, agencyId);

        return reply.status(200).send({
          success: true,
          data: result,
        });
      } catch (error) {
        app.log.error(error, `Error al cancelar reserva ${request.params.id}`);
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
      }
    },
  );
}
