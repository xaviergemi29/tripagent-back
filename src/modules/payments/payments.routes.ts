import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createPaymentBodySchema,
  createPaymentParamsSchema,
  voidPaymentBodySchema,
  voidPaymentParamsSchema,
} from "./payments.schema.js";
import { PaymentService } from "./payments.service.js";

export async function paymentRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/:bookingId/payments",
    {
      onRequest: [app.authenticate],
      schema: {
        params: createPaymentParamsSchema,
        body: createPaymentBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { bookingId } = request.params;
        const { agencyId, id: operatorId } = request.user;

        const result = await PaymentService.registerPayment(
          bookingId,
          request.body,
          agencyId,
          operatorId,
        );

        return reply.status(201).send({
          success: true,
          data: result,
        });
      } catch (error) {
        app.log.error(error, "Error en el registro de pagos");

        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
      }
    },
  );

  server.post(
    "/:bookingId/payments/:paymentId/void",
    {
      onRequest: [app.authenticate],
      schema: {
        params: voidPaymentParamsSchema,
        body: voidPaymentBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { bookingId, paymentId } = request.params;
        const { agencyId, id: operatorId } = request.user;
        const result = await PaymentService.voidPayment(
          bookingId,
          paymentId,
          request.body.reason,
          agencyId,
          operatorId,
        );

        return reply.status(200).send({
          success: true,
          message: "Abono anulado correctamente",
          data: result,
        });
      } catch (error) {
        app.log.error(error, "Error en el registro de pagos");
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
      }
    },
  );
}
