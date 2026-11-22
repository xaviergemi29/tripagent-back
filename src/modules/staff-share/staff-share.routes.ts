import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getStaffShareParamsSchema } from "./staff-share.schema.js";
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
}
