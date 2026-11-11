import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { MagicTokenService } from "./magic-token.service.js";
import {
  lookupTravelerQuerySchema,
  tokenValidationResponseSchema,
  validateTokenParamsSchema,
} from "./magic-token.schema.js";
import { TravelerService } from "../travelers/travelers.service.js";

export async function magicTokensRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/:token/validate",
    {
      schema: {
        params: validateTokenParamsSchema,
        response: {
          // 200: tokenValidationResponseSchema,
          // // Devolvemos 400s semánticos según el fallo de negocio
          // 404: tokenValidationResponseSchema,
          // 410: tokenValidationResponseSchema, // 410 Gone (para expirados)
          // 409: tokenValidationResponseSchema, // 409 Conflict (para llenos)
        },
      },
    },
    async (request, reply) => {
      try {
        const { token } = request.params;
        const result = await MagicTokenService.validate(token);

        if (result.error) {
          const statusCode =
            result.error.code === "NOT_FOUND" ? 404 : result.error.code === "EXPIRED" ? 410 : 409;

          return reply.status(statusCode).send({ isValid: false, error: result.error });
        }

        return reply.status(200).send(result);
      } catch (error) {
        app.log.error(error, "Error interno validando token");
        return reply.status(500).send({
          isValid: false,
          error: { code: "NOT_FOUND", message: "Error interno del servidor" },
        });
      }
    },
  );

  server.get(
    "/:token/lookup-traveler",
    {
      schema: {
        params: validateTokenParamsSchema,
        querystring: lookupTravelerQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const { token } = request.params;
        const { phone } = request.query;

        const magicTokenData = await MagicTokenService.validate(token);
        if (!magicTokenData || !magicTokenData.isValid) {
          return reply.status(400).send({ error: "Token inválido o expirado" });
        }

        const traveler = await TravelerService.findSingleTravelerByPhone(
          phone,
          magicTokenData.meta.agencyId,
        );

        if (!traveler) {
          return reply.status(404).send({ message: "No registrado" });
        }

        return reply.status(200).send({
          fullName: traveler.fullName,
          email: traveler.email,
          emergencyContactName: traveler.emergencyContactName,
          emergencyContactPhone: traveler.emergencyContactPhone,
          birthDate: traveler.birthDate,
        });
      } catch (error) {
        app.log.error(error, "Error en lookup público de viajero");
        return reply.status(500).send({ error: "Error interno" });
      }
    },
  );
}
