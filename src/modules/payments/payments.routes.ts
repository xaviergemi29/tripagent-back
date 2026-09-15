import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createPaymentBodySchema, createPaymentParamsSchema, voidPaymentBodySchema, voidPaymentParamsSchema } from "./payments.schema.js";
import { PaymentService } from "./payments.service.js";
import { AGENCY_ID } from "../../constants.js";

export async function paymentRoutes(app: FastifyInstance) {
    const server = app.withTypeProvider<ZodTypeProvider>();

    server.post(
        "/:bookingId/payments",
        {
            schema: {
                params: createPaymentParamsSchema,
                body: createPaymentBodySchema
            }
        },
        async (request, reply) => {
            try {
                const { bookingId } = request.params;
                
                const result = await PaymentService.registerPayment(
                    bookingId, 
                    request.body, 
                    AGENCY_ID
                );
                
                return reply.status(201).send({
                    success: true,
                    data: result
                });

            } catch (error) {
                app.log.error(error, "Error en el registro de pagos");
                
                const errorMessage = error instanceof Error 
                    ? error.message 
                    : "Error interno del servidor al procesar el pago";
                
                const statusCode = errorMessage.includes("no encontrada") ? 404 : 400;
                
                return reply.status(statusCode).send({ error: errorMessage });
            }
        }
    );

    server.post(
        "/:bookingId/payments/:paymentId/void",
        {
            schema: {
                params: voidPaymentParamsSchema,
                body: voidPaymentBodySchema
            }
        },    
        async(request, reply) => {
            try {

                
                
            } catch (error) {
                app.log.error(error, "Error en el registro de pagos");
                
                const errorMessage = error instanceof Error 
                    ? error.message 
                    : "Error interno del servidor al procesar el pago";
                
                const statusCode = errorMessage.includes("no encontrada") ? 404 : 400;
                
                return reply.status(statusCode).send({ error: errorMessage });
            }
        }
    )
}