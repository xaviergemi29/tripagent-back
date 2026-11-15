import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { publicPreBookingBodySchema } from "./booking.schema.js";
import { BookingService } from "./booking.service.js";
import { RATE_LIMITS } from "../../shared/security/rate-limits.js";

/**
 * Rutas públicas (sin sesión) de reservas. Prefijo: /api/public.
 * 404 tour inexistente o cancelado, 409 sin cupo / tour ya salido / WhatsApp ya inscrito: los
 * traduce el manejador global (errores de dominio). Un 500 nunca expone detalles.
 */
export async function bookingPublicRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/pre-booking",
    { config: { rateLimit: RATE_LIMITS.preBooking }, schema: { body: publicPreBookingBodySchema } },
    async (request, reply) => {
      await BookingService.createPublicPreBooking(request.body);
      // Respuesta mínima: el cliente no recibe token, ids ni datos de otras reservas.
      return reply.status(201).send({
        success: true,
        message: "Solicitud registrada. La agencia confirmará tus lugares por WhatsApp.",
      });
    },
  );
}
