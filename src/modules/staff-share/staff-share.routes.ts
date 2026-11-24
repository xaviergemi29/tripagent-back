import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getStaffShareParamsSchema } from "./staff-share.schema.js";
import {
  publicBoardingParamsSchema,
  publicBoardingPassengerParamsSchema,
  setBoardingBodySchema,
} from "../boarding/boarding.schema.js";
import { StaffShareService } from "./staff-share.service.js";
import { RATE_LIMITS } from "../../shared/security/rate-limits.js";

/**
 * Enlace de staff público (sin sesión; regla 26 de `../CLAUDE.md`). Prefijo: /api/public/staff-share.
 * Datos personales de los pasajeros: nunca se cachea ni se indexa.
 */
export async function staffSharePublicRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Robots-Tag", "noindex, nofollow");
  });

  server.get(
    "/:token",
    {
      config: { rateLimit: RATE_LIMITS.staffShare },
      schema: { params: getStaffShareParamsSchema },
    },
    async (request, reply) => {
      const data = await StaffShareService.getPublicView(request.params.token);
      return reply.status(200).send({ data });
    },
  );

  // Pase de lista desde el enlace (RB-MAN-002): la página lo vuelve a pedir cada 15 s y cada toque
  // es un PATCH; límite propio para no consumir las 120 lecturas de la vista completa.
  server.get(
    "/:token/boarding",
    {
      config: { rateLimit: RATE_LIMITS.staffShareBoarding },
      schema: { params: publicBoardingParamsSchema },
    },
    async (request, reply) => {
      const data = await StaffShareService.getPublicBoarding(request.params.token);
      return reply.status(200).send({ data });
    },
  );

  server.patch(
    "/:token/boarding/:boardingKey",
    {
      config: { rateLimit: RATE_LIMITS.staffShareBoarding },
      schema: { params: publicBoardingPassengerParamsSchema, body: setBoardingBodySchema },
    },
    async (request, reply) => {
      const data = await StaffShareService.setPublicBoarding(
        request.params.token,
        request.params.boardingKey,
        request.body.boarded,
      );
      return reply.status(200).send({ data });
    },
  );
}
