import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { TravelerService } from "./travelers.service.js";
import {
  createTravelerBodySchema,
  getTravelerByIdParamsSchema,
  getTravelersQuerySchema,
  updateTravelerBodySchema,
} from "./travelers.schema.js";

export async function travelerRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // 1. GET /
  server.get(
    "/",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: getTravelersQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const result = await TravelerService.findTravelers(request.query, agencyId);
        return reply.status(200).send(result);
      } catch (error) {
        app.log.error(error, "Error al consultar viajeros");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  // 2. GET /:id
  server.get(
    "/:travelerId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTravelerByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { travelerId } = request.params;
        const { agencyId } = request.user;
        const traveler = await TravelerService.findTravelerById(travelerId, agencyId);
        if (!traveler) {
          return reply.status(404).send({
            error: "Viajero no encontrado",
          });
        }
        return reply.status(200).send({ data: traveler });
      } catch (error) {
        app.log.error(error, "Error al consultar viajero por ID");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.get(
    "/:travelerId/history",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTravelerByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const history = await TravelerService.getTravelerHistory(
          request.params.travelerId,
          agencyId,
        );
        if (!history) return reply.status(400).send({ error: "Viajeor no encontrado" });
        return reply.status(200).send(history);
      } catch (error) {
        app.log.error(error, "Error al consultar historial del viajero");
        return reply.status(500).send({ error: "Error interno" });
      }
    },
  );

  // 3. PATCH /:id
  server.patch(
    "/:travelerId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTravelerByIdParamsSchema,
        body: updateTravelerBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { travelerId } = request.params;
        const { agencyId } = request.user;
        const body = request.body;
        const result = await TravelerService.updateTraveler(travelerId, body, agencyId);

        if (!result) {
          return reply.status(404).send({
            error: "Viajero no encontrado",
          });
        }

        return reply.status(200).send({ data: result });
      } catch (error: any) {
        app.log.error(error, "Error al actualizar viajero");

        if (error?.code === "23505") {
          return reply.status(409).send({
            error: "El correo electrónico o teléfono ya está registrado por otro viajero",
          });
        }
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  // 4. DELETE /:id (Cambiado de 'app.delete' a 'server.delete')
  server.delete(
    "/:travelerId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: getTravelerByIdParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { travelerId } = request.params;
        const { agencyId } = request.user;
        const result = await TravelerService.softDeleteTraveler(travelerId, agencyId);

        if (!result) {
          return reply.status(404).send({
            error: "Viajero no encontrado",
          });
        }

        return reply.status(200).send({
          data: result,
        });
      } catch (error: any) {
        app.log.error(error, "Error al eliminar viajero por ID");

        if (error?.code === "23503") {
          return reply.status(409).send({
            error: "No se puede eliminar el viajero porque tiene registros o reservas asociadas",
          });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.post(
    "/",
    {
      onRequest: [app.authenticate],
      schema: {
        body: createTravelerBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const insertedTraveler = await TravelerService.creteTraveler(request.body, agencyId);
        return reply.status(201).send(insertedTraveler);
      } catch (error: any) {
        app.log.error(error, "Error al crear el viajero");

        if (error?.code === "23505") {
          return reply
            .status(409)
            .send({ error: "Ya existe un viajero registrado con ese título" });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
