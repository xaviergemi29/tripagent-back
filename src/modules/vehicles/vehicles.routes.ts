import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createVehicleBodySchema } from "./vehicles.schema.js";
import { VehiclesService } from "./vehicles.service.js";

export async function vehicleRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/", async (_, reply) => {
    try {
      const data = await VehiclesService.getAllVehicles();
      return reply.send(data);
    } catch (error) {
      app.log.error(error, "Error fetching vehicles");
      return reply.status(500).send({ error: "Error interno del servidor" });
    }
  });

  server.post(
    "/",
    {
      schema: {
        body: createVehicleBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const vehicle = await VehiclesService.createVehicle(request.body);
        return reply.status(201).send(vehicle);
      } catch (error) {
        app.log.error(error, "Error creating vehicle");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
