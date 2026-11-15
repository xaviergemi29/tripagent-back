import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  getAgencybyIdParamSchema,
  updateAgencyBodySchema,
  updateBrandingBodySchema,
  updatePoliciesBodySchema,
} from "./agency.schema.js";
import { Agency } from "./agency.service.js";
import { AgencyBrandingService } from "./agency-branding.service.js";
import {
  ensureUploadDirs,
  hasFileSignature,
  removeAbsoluteFile,
  toPublicUploadPath,
  writeUpload,
  type FileKind,
} from "../../shared/storage/uploads.js";

/** Logotipo: PNG o JPEG (jsPDF no puede insertar SVG en el comprobante), máximo 2 MB. */
const LOGO_MIME_EXTENSIONS: Record<string, FileKind> = { "image/png": "png", "image/jpeg": "jpg" };
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_TOO_LARGE = "El logotipo no debe pesar más de 2 MB";
const LOGO_INVALID = "El logotipo debe ser una imagen PNG o JPG";

/**
 * Agencia de la sesión. Prefijo: /api/agencies. El `agencyId` SIEMPRE sale de `request.user`.
 *
 * `POST /` (crear agencia) se eliminó el 2026-11-15 (auditoría): no tenía consumidores (las agencias
 * se crean por CLI, `npm run tenant:create`) y cualquier usuario autenticado podía crear agencias con
 * `subscriptionStatus: "active"`.
 */
export async function agencyRoute(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  ensureUploadDirs();

  server.get("/", { onRequest: [app.authenticate] }, async (request, reply) => {
    const agency = await Agency.findAgencyById(request.user.agencyId);
    if (!agency) return reply.status(404).send({ error: "Agencia no encontrada" });
    return reply.status(200).send({ data: agency });
  });

  server.patch(
    "/",
    { onRequest: [app.authenticate], schema: { body: updateAgencyBodySchema } },
    async (request, reply) => {
      const agency = await Agency.updateAgency(request.user.agencyId, request.body);
      return reply.status(200).send({ data: agency });
    },
  );

  // Políticas generales de la agencia (se leen con GET /agencies; se imprimen en el PDF).
  server.patch(
    "/policies",
    { onRequest: [app.authenticate], schema: { body: updatePoliciesBodySchema } },
    async (request, reply) => {
      const updated = await Agency.updatePolicies(request.user.agencyId, request.body.policies);
      if (!updated) return reply.status(404).send({ error: "Agencia no encontrada" });
      return reply.status(200).send({ data: { policies: updated.policies ?? null } });
    },
  );

  // Identidad visual (colores de agency_branding + logotipo físico en agencies.logoPath).
  server.get("/branding", { onRequest: [app.authenticate] }, async (request, reply) => {
    const branding = await AgencyBrandingService.getBranding(request.user.agencyId);
    if (!branding) return reply.status(404).send({ error: "Agencia no encontrada" });
    return reply.status(200).send({ data: branding });
  });

  server.patch(
    "/branding",
    { onRequest: [app.authenticate], schema: { body: updateBrandingBodySchema } },
    async (request, reply) => {
      try {
        const branding = await AgencyBrandingService.updateColors(
          request.user.agencyId,
          request.body,
        );
        if (!branding) return reply.status(404).send({ error: "Agencia no encontrada" });
        return reply.status(200).send({ data: branding });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "23503") {
          return reply.status(404).send({ error: "Agencia no encontrada" });
        }
        throw error;
      }
    },
  );

  /**
   * Logotipo (multipart, campo `file`). Se valida el mimetype declarado Y la firma real del archivo
   * (PNG/JPEG); se escribe el archivo, se actualiza la base y después se borra el anterior. Si algo
   * falla, el archivo nuevo no queda huérfano.
   */
  server.post("/logo", { onRequest: [app.authenticate] }, async (request, reply) => {
    const { agencyId } = request.user;
    let savedPath: string | null = null;
    try {
      const file = await request.file({ limits: { fileSize: LOGO_MAX_BYTES } });
      if (!file) return reply.status(400).send({ error: "No se adjuntó ningún archivo" });

      const kind = LOGO_MIME_EXTENSIONS[file.mimetype];
      if (!kind) {
        file.file.resume();
        return reply.status(400).send({ error: LOGO_INVALID });
      }

      const fileName = `agency-${agencyId}-${Date.now()}.${kind}`;
      savedPath = await writeUpload("logos", fileName, file.file);

      if (file.file.truncated) return reply.status(400).send({ error: LOGO_TOO_LARGE });
      if (!(await hasFileSignature(savedPath, kind))) {
        return reply.status(400).send({ error: LOGO_INVALID });
      }

      const { previousLogoPath } = await AgencyBrandingService.setLogoPath(
        agencyId,
        toPublicUploadPath("logos", fileName),
      );
      savedPath = null; // La base ya apunta al archivo nuevo: no se borra.
      await AgencyBrandingService.removeLogoFile(previousLogoPath);

      const branding = await AgencyBrandingService.getBranding(agencyId);
      return reply.status(200).send({ data: branding });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.status(400).send({ error: LOGO_TOO_LARGE });
      }
      throw error;
    } finally {
      await removeAbsoluteFile(savedPath);
    }
  });

  server.delete("/logo", { onRequest: [app.authenticate] }, async (request, reply) => {
    const { agencyId } = request.user;
    const { previousLogoPath } = await AgencyBrandingService.setLogoPath(agencyId, null);
    await AgencyBrandingService.removeLogoFile(previousLogoPath);
    const branding = await AgencyBrandingService.getBranding(agencyId);
    return reply.status(200).send({ data: branding });
  });

  // Sin consumidores en el front; protegido: solo la propia agencia (403 si no).
  server.get(
    "/:id",
    { onRequest: [app.authenticate], schema: { params: getAgencybyIdParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      if (id !== request.user.agencyId) {
        return reply.status(403).send({ error: "No tienes acceso a esta agencia" });
      }
      const agency = await Agency.findAgencyById(id);
      if (!agency) return reply.status(404).send({ error: "Agencia no encontrada" });
      return reply.status(200).send({ data: agency });
    },
  );
}
