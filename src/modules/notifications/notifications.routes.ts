import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { notificationParamsSchema } from "./notifications.schema.js";
import { NotificationService } from "./notifications.service.js";

/**
 * Notificaciones in-app de la agencia de la sesión. Prefijo: /api/notifications.
 * El `agencyId` SIEMPRE sale de `request.user`.
 */
export async function notificationRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // { data: { items, unreadCount } } → el front recibe { items, unreadCount }.
  server.get("/", { onRequest: [app.authenticate] }, async (request, reply) => {
    const result = await NotificationService.list(request.user.agencyId);
    return reply.send({ data: result });
  });

  // Se declara antes de "/:id/read" por claridad; Fastify prioriza la ruta estática de todos modos.
  server.patch("/read-all", { onRequest: [app.authenticate] }, async (request, reply) => {
    const result = await NotificationService.markAllAsRead(request.user.agencyId);
    return reply.send({ data: result });
  });

  server.patch(
    "/:id/read",
    { onRequest: [app.authenticate], schema: { params: notificationParamsSchema } },
    async (request, reply) => {
      const result = await NotificationService.markAsRead(request.params.id, request.user.agencyId);
      return reply.send({ data: result });
    },
  );
}
