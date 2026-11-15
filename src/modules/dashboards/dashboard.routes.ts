import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { GetDashboardParamsSchema } from "./dashboard.schema.js";
import { DashboardService } from "./dashboard.service.js";

/**
 * BFF del Centro de Control. Prefijo: /api/dashboards. Responde el objeto directo (sin `data`).
 * 404 si el tour no existe o es de otra agencia (manejador global).
 */
export async function dashboardRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:id",
    { onRequest: [app.authenticate], schema: { params: GetDashboardParamsSchema } },
    async (request, reply) => {
      const dashboardData = await DashboardService.getTourDashboard(
        request.user.agencyId,
        request.params.id,
      );
      return reply.status(200).send(dashboardData);
    },
  );
}
