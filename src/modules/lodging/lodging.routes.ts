import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  assignLodgingSlotsBodySchema,
  createLodgingRoomsBodySchema,
  lodgingRoomParamsSchema,
  lodgingSlotParamsSchema,
  lodgingTourParamsSchema,
  updateLodgingRoomBodySchema,
} from "./lodging.schema.js";
import { LodgingService, ROOM_NUMBER_IN_USE } from "./lodging.service.js";

/** Código de Postgres de una violación de restricción (unique, FK), si el error lo trae. */
const pgCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

/**
 * Hospedaje del tour (regla 27): hoteles, habitaciones y rooming list. Prefijo: /api/lodging.
 * El `agencyId` SIEMPRE sale de `request.user`; los errores de dominio los traduce app.ts.
 */
export async function lodgingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:tourId",
    { onRequest: [app.authenticate], schema: { params: lodgingTourParamsSchema } },
    async (request, reply) => {
      const result = await LodgingService.getTourLodging(
        request.params.tourId,
        request.user.agencyId,
      );
      return reply.send({ data: result });
    },
  );

  server.post(
    "/:tourId/rooms",
    {
      onRequest: [app.authenticate],
      schema: { params: lodgingTourParamsSchema, body: createLodgingRoomsBodySchema },
    },
    async (request, reply) => {
      const result = await LodgingService.createRooms(
        request.params.tourId,
        request.body,
        request.user.agencyId,
        request.user.id,
      );
      return reply.status(201).send({ data: result });
    },
  );

  // Número de cuarto (null = quitarlo) o estado de la habitación. Número repetido → 409.
  server.patch(
    "/:tourId/rooms/:roomId",
    {
      onRequest: [app.authenticate],
      schema: { params: lodgingRoomParamsSchema, body: updateLodgingRoomBodySchema },
    },
    async (request, reply) => {
      try {
        const room = await LodgingService.updateRoom(
          request.params.tourId,
          request.params.roomId,
          request.body,
          request.user.agencyId,
        );
        return reply.send({ data: { room } });
      } catch (error) {
        // Dos envíos simultáneos con el mismo número: lo detiene el índice único parcial.
        if (pgCode(error) === "23505") {
          return reply.status(409).send({ error: ROOM_NUMBER_IN_USE });
        }
        throw error;
      }
    },
  );

  // Asigna uno o varios pasajeros (p. ej. una pareja) a camas de la habitación, todo o nada.
  server.post(
    "/:tourId/rooms/:roomId/assignments",
    {
      onRequest: [app.authenticate],
      schema: { params: lodgingRoomParamsSchema, body: assignLodgingSlotsBodySchema },
    },
    async (request, reply) => {
      const room = await LodgingService.assignSlots(
        request.params.tourId,
        request.params.roomId,
        request.body,
        request.user.agencyId,
        request.user.id,
      );
      return reply.status(201).send({ data: { room } });
    },
  );

  server.delete(
    "/:tourId/rooms/:roomId/slots/:slotIndex",
    { onRequest: [app.authenticate], schema: { params: lodgingSlotParamsSchema } },
    async (request, reply) => {
      const room = await LodgingService.unassignSlot(
        request.params.tourId,
        request.params.roomId,
        request.params.slotIndex,
        request.user.agencyId,
      );
      return reply.send({ data: { room } });
    },
  );

  // Elimina la habitación; sus pasajeros vuelven a "sin habitación". El hotel se conserva.
  server.delete(
    "/:tourId/rooms/:roomId",
    { onRequest: [app.authenticate], schema: { params: lodgingRoomParamsSchema } },
    async (request, reply) => {
      const result = await LodgingService.deleteRoom(
        request.params.tourId,
        request.params.roomId,
        request.user.agencyId,
      );
      return reply.send({ data: result });
    },
  );

  // Elimina la cama completa del lugar (matrimonial = 2 lugares) y recorre los siguientes. Última cama → 409.
  server.delete(
    "/:tourId/rooms/:roomId/beds/:slotIndex",
    { onRequest: [app.authenticate], schema: { params: lodgingSlotParamsSchema } },
    async (request, reply) => {
      const result = await LodgingService.deleteBed(
        request.params.tourId,
        request.params.roomId,
        request.params.slotIndex,
        request.user.agencyId,
      );
      return reply.send({ data: result });
    },
  );
}
