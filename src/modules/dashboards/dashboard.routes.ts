import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { GetDashboardParamsSchema } from "./dashboard.schema.js";
import { DashboardService } from "./dashboard.service.js";
import { AGENCY_ID } from "../../constants.js";

export async function dashboardRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:id",
    {
      schema: {
        params: GetDashboardParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const dashboardData = await DashboardService.getTourDashboard(AGENCY_ID, request.params.id);
        return reply.status(200).send(dashboardData);
      } catch (error) {
        // ✅ 1. Loguear para el backend (esencial en Node.js)
        app.log.error(error, "Error al obtener el dashboard");

        // ✅ 2. Mapear el error a un código HTTP correcto
        if (error.message === "Tour no encontrado") {
          return reply.status(404).send({ error: error.message });
        }

        // ✅ 3. Error genérico
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
