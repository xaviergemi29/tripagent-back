import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  addPassengerToBookingBody,
  bookingByIdParamsSchema,
  cancelBookingBodySchema,
  cancelBookingParamsSchema,
  cancelFullBookingBodySchema,
  createBookingBodySchema,
  newReservationBookingSchema,
  tourByIdParamsSchema,
} from "./booking.schema.js";
import { BookingService } from "./booking.service.js";

export async function bookingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/public/register",
    {
      schema: { body: createBookingBodySchema },
    },
    async (request, reply) => {
      try {
        const booking = await BookingService.processGroupBooking(request.body);
        if (!booking) {
          return reply.status(400).send({ error: "Booking no procesado" });
        }
        return reply.status(201).send(booking);
      } catch (error) {
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
      }
    },
  );

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
        const booking = await BookingService.processGroupBooking(request.body);
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
          if (error instanceof Error && error.message === "Tour no encontrado") {
            return reply.status(404).send({ error: error.message });
          }
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

  server.post(
    "/:bookingId/add-passenger",
    {
      onRequest: [app.authenticate],
      schema: {
        params: bookingByIdParamsSchema,
        body: addPassengerToBookingBody,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const { bookingId } = request.params;
        const { tourId } = request.body;
        const result = await BookingService.addPassengerToBooking(bookingId, tourId, agencyId);
        return reply.status(200).send(result);
      } catch (error) {
        app.log.error(error, `Error al agregar viajero a reserva ${request.params.bookingId}`);
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
      }
    },
  );

  server.delete(
    "/:bookingId/pending-slots",
    {
      onRequest: [app.authenticate],
      schema: {
        params: bookingByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const { bookingId } = request.params;

        const result = await BookingService.removePendingSlot(bookingId, agencyId);

        return reply.status(200).send(result);
      } catch (error) {
        app.log.error(
          error,
          `Error al liberar cupo fantasma en reserva ${request.params.bookingId}`,
        );
        // Degradación semántica de errores para no enviar siempre un 500
        const statusCode = error instanceof Error && error.message.includes("inválida") ? 404 : 400;
        return reply.status(statusCode).send({
          error: error instanceof Error ? error.message : "Error interno del servidor",
        });
      }
    },
  );

  server.patch(
    "/:id/cancel-full",
    {
      onRequest: [app.authenticate],
      schema: {
        params: cancelBookingParamsSchema,
        body: cancelFullBookingBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const { penaltyAmount } = request.body;
        const { agencyId } = request.user;

        // Llamada al nuevo método del servicio
        const result = await BookingService.cancelFullBooking(id, penaltyAmount, agencyId);

        return reply.status(200).send({
          success: true,
          data: result,
        });
      } catch (error) {
        app.log.error(error, `Error al cancelar reserva completa ${request.params.id}`);
        // Retornamos 400 en lugar de 500 si es un error de regla de negocio
        const statusCode =
          error instanceof Error && error.message.includes("penalización") ? 400 : 500;
        return reply
          .status(statusCode)
          .send({ error: error instanceof Error ? error.message : "Error interno" });
      }
    },
  );
}
