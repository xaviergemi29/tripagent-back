import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { TravelerService } from "./travelers.service.js";
import {
  getTravelerByIdParamsSchema,
  getTravelersQuerySchema,
  updateTravelerBodySchema,
} from "./travelers.schema.js";
import { getErrorCode } from "../../shared/utils/db-error.util.js";

/** CRM de viajeros de la agencia de la sesión. Prefijo: /api/travelers. */
export async function travelerRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/",
    { onRequest: [app.authenticate], schema: { querystring: getTravelersQuerySchema } },
    async (request, reply) => {
      const result = await TravelerService.findTravelers(request.query, request.user.agencyId);
      return reply.status(200).send(result);
    },
  );

  server.get(
    "/:travelerId/history",
    { onRequest: [app.authenticate], schema: { params: getTravelerByIdParamsSchema } },
    async (request, reply) => {
      const history = await TravelerService.getTravelerHistory(
        request.params.travelerId,
        request.user.agencyId,
      );
      // 404 (antes 400 con el texto "Viajeor no encontrado").
      if (!history) return reply.status(404).send({ error: "Viajero no encontrado" });
      return reply.status(200).send(history);
    },
  );

  server.patch(
    "/:travelerId",
    {
      onRequest: [app.authenticate],
      schema: { params: getTravelerByIdParamsSchema, body: updateTravelerBodySchema },
    },
    async (request, reply) => {
      try {
        const result = await TravelerService.updateTraveler(
          request.params.travelerId,
          request.body,
          request.user.agencyId,
        );
        if (!result) return reply.status(404).send({ error: "Viajero no encontrado" });
        return reply.status(200).send({ data: result });
      } catch (error) {
        if (getErrorCode(error) === "23505") {
          return reply.status(409).send({
            error: "El correo electrónico o teléfono ya está registrado por otro viajero",
          });
        }
        throw error;
      }
    },
  );

  // Borrado lógico + anonimización (derecho ARCO): conserva reservas y pagos sin datos personales.
  // 409 si tiene un viaje próximo o en curso (manejador global).
  server.delete(
    "/:travelerId",
    { onRequest: [app.authenticate], schema: { params: getTravelerByIdParamsSchema } },
    async (request, reply) => {
      try {
        const result = await TravelerService.softDeleteTraveler(
          request.params.travelerId,
          request.user.agencyId,
        );
        if (!result) return reply.status(404).send({ error: "Viajero no encontrado" });
        return reply.status(200).send({ data: result });
      } catch (error) {
        if (getErrorCode(error) === "23503") {
          return reply.status(409).send({
            error: "No se puede eliminar el viajero porque tiene registros o reservas asociadas",
          });
        }
        throw error;
      }
    },
  );
}
