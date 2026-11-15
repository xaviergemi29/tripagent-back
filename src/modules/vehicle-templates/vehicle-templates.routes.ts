import type { FastifyInstance } from "fastify";
import { VehicleTemplatesService } from "./vehicle-templates.service.js";

/** Catálogo global de plantillas de vehículos (solo lectura, cualquier agencia con sesión). */
export async function vehicleTemplateRoutes(app: FastifyInstance) {
  app.get("/", { onRequest: [app.authenticate] }, async (_request, reply) => {
    const templates = await VehicleTemplatesService.findActiveTemplates();
    return reply.status(200).send({ data: templates });
  });
}
