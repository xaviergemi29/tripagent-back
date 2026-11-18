import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  addPassengerToBookingBody,
  bookingByIdParamsSchema,
  cancelBookingParamsSchema,
  cancelFullBookingBodySchema,
  publicRegisterBodySchema,
  newReservationBookingSchema,
  tourByIdParamsSchema,
  transferPassengerBodySchema,
} from "./booking.schema.js";
import { BookingService } from "./booking.service.js";
import { RATE_LIMITS } from "../../shared/security/rate-limits.js";

/**
 * Reservas. Prefijo: /api/bookings. Sin try/catch: los errores de dominio (NotFound → 404,
 * BusinessRule → 400, Conflict → 409) y los 500 los traduce el manejador global de app.ts.
 *
 * `POST /` (registro de grupo con sesión) se eliminó el 2026-11-15 (auditoría de arquitectura): no
 * tenía consumidores, duplicaba `POST /public/register` sin exigir el aviso de privacidad (regla 19)
 * y no comprobaba que el token fuera de la agencia de la sesión.
 */
export async function bookingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Registro del grupo desde el Magic Link (público: lo autentica el token del cuerpo).
  server.post(
    "/public/register",
    {
      config: { rateLimit: RATE_LIMITS.publicRegister },
      schema: { body: publicRegisterBodySchema },
    },
    async (request, reply) => {
      const booking = await BookingService.processGroupBooking(request.body);
      return reply.status(201).send(booking);
    },
  );

  server.post(
    "/:id/quick-booking",
    {
      onRequest: [app.authenticate],
      schema: { body: newReservationBookingSchema, params: tourByIdParamsSchema },
    },
    async (request, reply) => {
      const result = await BookingService.createQuickBooking(
        request.params.id,
        request.body,
        request.user.agencyId,
      );
      return reply.status(201).send({ success: true, data: result });
    },
  );

  server.post(
    "/:bookingId/add-passenger",
    {
      onRequest: [app.authenticate],
      schema: { params: bookingByIdParamsSchema, body: addPassengerToBookingBody },
    },
    async (request, reply) => {
      const result = await BookingService.addPassengerToBooking(
        request.params.bookingId,
        request.body.tourId,
        request.user.agencyId,
      );
      return reply.status(200).send(result);
    },
  );

  server.delete(
    "/:bookingId/pending-slots",
    { onRequest: [app.authenticate], schema: { params: bookingByIdParamsSchema } },
    async (request, reply) => {
      const result = await BookingService.removePendingSlot(
        request.params.bookingId,
        request.user.agencyId,
      );
      return reply.status(200).send(result);
    },
  );

  server.patch(
    "/:id/cancel-full",
    {
      onRequest: [app.authenticate],
      schema: { params: cancelBookingParamsSchema, body: cancelFullBookingBodySchema },
    },
    async (request, reply) => {
      const result = await BookingService.cancelFullBooking(
        request.params.id,
        request.body.penaltyAmount,
        request.user.agencyId,
      );
      return reply.status(200).send({ success: true, data: result });
    },
  );

  // Transferencia de un lugar (titular o acompañante) a otra persona.
  server.patch(
    "/:bookingId/transfer",
    {
      onRequest: [app.authenticate],
      schema: { params: bookingByIdParamsSchema, body: transferPassengerBodySchema },
    },
    async (request, reply) => {
      try {
        const result = await BookingService.transferPassenger(
          request.params.bookingId,
          request.body,
          request.user.agencyId,
        );
        return reply.status(200).send({ success: true, data: result });
      } catch (error) {
        // Carrera con el índice único (viajero activo dos veces en el tour).
        if (error instanceof Error && "code" in error && error.code === "23505") {
          return reply
            .status(409)
            .send({ error: "Esta persona ya tiene un lugar activo en este tour." });
        }
        throw error;
      }
    },
  );
}
