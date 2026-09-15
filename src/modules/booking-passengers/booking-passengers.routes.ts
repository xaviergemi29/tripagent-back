import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { cancelPassengerParamsSchema, cancelPassengerBodySchema, addPassengerParamsSchema, addPassengerBodySchema } from "./booking-passengers.schema.js";
import { BookingPassengerService } from "./booking-passengers.service.js";
import { AGENCY_ID } from "../../constants.js";

export async function bookingPassengersRoutes(app: FastifyInstance) {
    const server = app.withTypeProvider<ZodTypeProvider>();

    server.patch(
        "/:bookingId/passengers/:travelerId/cancel",
        {
            schema: {
                params: cancelPassengerParamsSchema,
                body: cancelPassengerBodySchema
            }
        },
        async (request, reply) => {
            try {
                const { bookingId, travelerId } = request.params;
                const { penaltyAmount } = request.body;
                
                const result = await BookingPassengerService.cancelPassenger(
                    bookingId, 
                    travelerId, 
                    penaltyAmount,
                    AGENCY_ID
                );
                
                return reply.status(200).send({
                    success: true,
                    data: result
                });

            } catch (error) {
                app.log.error(error, "Error al cancelar pasajero parcial");
                
                const errorMessage = error instanceof Error 
                    ? error.message 
                    : "Error interno al procesar la cancelación parcial";
                
                const statusCode = errorMessage.includes("no encontrad") ? 404 : 400;
                
                return reply.status(statusCode).send({ error: errorMessage });
            }
        }
    );

    //NUEVA RUTA: Agregar o reincorporar un pasajero a la reserva
    server.post(
        "/:bookingId/passengers",
        {
            schema: {
                params: addPassengerParamsSchema,
                body: addPassengerBodySchema
            }
        },
        async (request, reply) => {
            try {
                const { bookingId } = request.params;
                const { travelerId, passengerType, boardingPoint } = request.body;

                const result = await BookingPassengerService.addOrReactivatePassenger(
                    bookingId,
                    travelerId,
                    passengerType,
                    boardingPoint,
                    AGENCY_ID
                );

                return reply.status(201).send({ success: true, data: result });
            } catch (error) {
                app.log.error(error, "Error al agregar/reactivar pasajero");
                const errorMessage = error instanceof Error ? error.message : "Error interno";
                const statusCode = errorMessage.includes("no encontrad") ? 404 : 400;
                return reply.status(statusCode).send({ error: errorMessage });
            }
        }
    );
}