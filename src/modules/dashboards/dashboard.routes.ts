import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { GetDashboardParamsSchema } from "./dashboard.schema.js";
import { DashboardService } from "./dashboard.service.js";

export async function dashboardRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:id",
    {
      onRequest: [app.authenticate],
      schema: {
        params: GetDashboardParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const dashboardData = await DashboardService.getTourDashboard(agencyId, request.params.id);
        return reply.status(200).send(dashboardData);
      } catch (error) {
        // ✅ 1. Loguear para el backend (esencial en Node.js)
        app.log.error(error, "Error al obtener el dashboard");

        if (error instanceof Error) return reply.status(500).send({ error: error?.message });

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
