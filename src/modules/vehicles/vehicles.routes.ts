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
      if (error instanceof Error) return reply.status(500).send({ error: error?.message });
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
        const { body } = request;
        const vehicle = await VehiclesService.createVehicle(body);
        return reply.status(201).send(vehicle);
      } catch (error) {
        app.log.error(error, "Error creating vehicle");
        if (error instanceof Error) return reply.status(500).send({ error: error?.message });
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
