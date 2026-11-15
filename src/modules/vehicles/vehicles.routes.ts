import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createVehicleBodySchema } from "./vehicles.schema.js";
import { VehiclesService } from "./vehicles.service.js";

/** Unidades (vehículos) de la agencia de la sesión. Prefijo: /api/vehicles. */
export async function vehicleRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/", { onRequest: [app.authenticate] }, async (request, reply) => {
    const data = await VehiclesService.getAllVehicles(request.user.agencyId);
    return reply.send(data);
  });

  // Unidad con croquis propio (validado con layoutMapSchema), ligada a la agencia de la sesión.
  server.post(
    "/",
    { onRequest: [app.authenticate], schema: { body: createVehicleBodySchema } },
    async (request, reply) => {
      const vehicle = await VehiclesService.createVehicle(request.body, request.user.agencyId);
      return reply.status(201).send(vehicle);
    },
  );
}
