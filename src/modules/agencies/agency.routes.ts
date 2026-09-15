import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAgencyBodySchema, getAgencybyIdParamSchema } from "./agency.schema.js";
import { Agency } from "./agency.service.js";

export async function agencyRoute(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/",
    {
      schema: {
        body: createAgencyBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const agency = await Agency.createAgency(request.body);
        return reply.status(200).send(agency);
      } catch (error: any) {
        app.log.error(error, "Error al crear la agencia");

        if (error?.code === "23505") {
          return reply
            .status(409)
            .send({ error: "Ya existe una agencia registrado con ese título" });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.get(
    "/:id",
    {
      schema: {
        params: getAgencybyIdParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const insertedAgency = Agency.findAgencyById(request);
        if (!insertedAgency) {
          return reply.status(404).send({
            error: "Agencia no encontrado",
          });
        }
        return reply.status(200).send({ data: insertedAgency });
      } catch (error: any) {
        app.log.error(error, "Error al consultar viajero por ID");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
