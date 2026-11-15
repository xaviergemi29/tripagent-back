import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createPaymentBodySchema,
  createPaymentParamsSchema,
  voidPaymentBodySchema,
  voidPaymentParamsSchema,
} from "./payments.schema.js";
import { PaymentService } from "./payments.service.js";

/**
 * Libro de pagos. Prefijo: /api/payments. Los errores de dominio (404 reserva o abono ajeno,
 * 400 reembolso mayor al saldo, 409 tour cancelado / abono ya anulado) los traduce el manejador
 * global de app.ts.
 */
export async function paymentRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/:bookingId/payments",
    {
      onRequest: [app.authenticate],
      schema: { params: createPaymentParamsSchema, body: createPaymentBodySchema },
    },
    async (request, reply) => {
      const { agencyId, id: operatorId } = request.user;
      const result = await PaymentService.registerPayment(
        request.params.bookingId,
        request.body,
        agencyId,
        operatorId,
      );
      return reply.status(201).send({ success: true, data: result });
    },
  );

  server.post(
    "/:bookingId/payments/:paymentId/void",
    {
      onRequest: [app.authenticate],
      schema: { params: voidPaymentParamsSchema, body: voidPaymentBodySchema },
    },
    async (request, reply) => {
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
    },
  );
}
