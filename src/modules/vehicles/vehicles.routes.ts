import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { VehiclesService } from "./vehicles.service.js";

/**
 * Unidades (vehículos) de la agencia de la sesión. Prefijo: /api/vehicles. Solo lectura: las
 * unidades se crean desde el catálogo de plantillas al asignarlas a un tour
 * (`PATCH /tours/:id/vehicle` con `templateId`). `POST /` se eliminó el 2026-11-17 (OBS-024).
 */
export async function vehicleRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/", { onRequest: [app.authenticate] }, async (request, reply) => {
    const data = await VehiclesService.getAllVehicles(request.user.agencyId);
    return reply.send(data);
  });
}
