import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createAgencyBodySchema,
  getAgencybyIdParamSchema,
  updateAgencyBodySchema,
} from "./agency.schema.js";
import { Agency } from "./agency.service.js";

export async function agencyRoute(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/",
    {
      onRequest: [app.authenticate],
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
            .send({ error: "Ya existe una agencia registrada con ese título" });
        }

        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.get(
    "/",
    {
      onRequest: [app.authenticate],
    },
    async (request, reply) => {
      try {
        // Extraemos el ID con seguridad desde el token/sesión
        const { agencyId } = request.user;

        const agency = await Agency.findAgencyById(agencyId);

        if (!agency) {
          return reply.status(404).send({
            error: "Agencia no encontrada",
          });
        }

        // Empaquetamos en 'data' para mantener el estándar RESTful que definimos
        return reply.status(200).send({ data: agency });
      } catch (error: any) {
        app.log.error(error, "Error al consultar la agencia del usuario");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  server.patch(
    "/",
    {
      onRequest: [app.authenticate],
      schema: {
        body: updateAgencyBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const { agencyId } = request.user;
        const agency = await Agency.updateAgency(agencyId, request.body);
        return reply.status(200).send({ data: agency });
      } catch (error: any) {
        app.log.error(error, "Error al actualizar la agencia");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );

  // NOTA DE ARQUITECTURA:
  // Mantuve el GET /:id debajo por si en el futuro necesitas consultas públicas (ej. un cliente
  // viendo el perfil de la agencia para pagar) o vistas de Súper-Admin.
  // Si no tienes ese caso de uso actual, te sugiero borrarlo para reducir la superficie de ataque.
  server.get(
    "/:id",
    {
      schema: {
        params: getAgencybyIdParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const agency = await Agency.findAgencyById(id);
        if (!agency) {
          return reply.status(404).send({
            error: "Agencia no encontrada",
          });
        }
        return reply.status(200).send({ data: agency });
      } catch (error: any) {
        app.log.error(error, "Error al consultar agencia por ID");
        return reply.status(500).send({ error: "Error interno del servidor" });
      }
    },
  );
}
