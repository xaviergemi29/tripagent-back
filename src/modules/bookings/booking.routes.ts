import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { cancelBookingBodySchema, cancelBookingParamsSchema, createBookingBodySchema, newReservationBookingSchema, tourByIdParamsSchema } from "./booking.schema.js";
import { BookingService } from "./booking.service.js";
import { AGENCY_ID } from "../../constants.js";


export async function bookingRoutes(app: FastifyInstance) {
    const server = app.withTypeProvider<ZodTypeProvider>();

    server.post(
        "/",
        {
            schema: {
                body: createBookingBodySchema
            }
        },
        async (request, reply) => {
            try {
                const booking = await BookingService.processGroupBooking(request.body, AGENCY_ID);
                if (!booking) {
                    return reply.status(400).send({ error: "Booking no procesado" });
                }
                return reply.status(201).send(booking);
            } catch (error) {
                app.log.error(error, "Error al registrar grupo de viajeros");
                return reply.status(500).send({ error: "Error interno del servidor" });
            }
        }
    ),

        server.post(
            "/:id/quick-booking",
            {
                schema: {
                    body: newReservationBookingSchema,
                    params: tourByIdParamsSchema
                }
            },
            async (request, reply) => {
                try {
                    const result = await BookingService.createQuickBooking(request.params.id, request.body, AGENCY_ID);
                    return reply.status(201).send({ success: true, data: result });

                } catch (error) {
                    app.log.error(error, "Error en quick-booking");
                    // ✅ Fail Fast: Devolvemos HTTP 400 si la validación falla
                    const errorMessage = error instanceof Error ? error.message : "Error al procesar la reserva";

                    return reply.status(400).send({ error: errorMessage });
                }
            }
        )

    server.patch(
        "/:id/cancel",
        {
            schema: {
                params: cancelBookingParamsSchema,
                body: cancelBookingBodySchema
            }
        },
        async (request, reply) => {
            try {
                const { id } = request.params;
                const { penaltyPercentage } = request.body;

                const result = await BookingService.cancelBooking(
                    id,
                    penaltyPercentage,
                    AGENCY_ID
                );

                return reply.status(200).send({
                    success: true,
                    data: result
                });

            } catch (error) {
                // EJEMPLO DE APRENDIZAJE: Type Narrowing.
                // En TypeScript, los errores en un bloque catch son de tipo 'unknown'.
                // Debemos verificar si es una instancia de Error para leer su .message,
                // de lo contrario, lanzamos un string genérico.
                const errorMessage = error instanceof Error
                    ? error.message
                    : "Error interno al procesar la cancelación";

                app.log.error(error, `Error al cancelar reserva ${request.params.id}`);

                // Si el error dice que no encontró la reserva, el código HTTP semántico es 404 (Not Found).
                // Si es un error de lógica (ej. "Ya está cancelada"), es un 400 (Bad Request).
                const statusCode = errorMessage.includes("no encontrada") ? 404 : 400;

                return reply.status(statusCode).send({ error: errorMessage });
            }
        }
    );
};
