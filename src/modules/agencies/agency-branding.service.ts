import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies, agencyBranding } from "../../db/schema.js";
import type { UpdateBrandingBody } from "./agency.schema.js";
import { NotFoundError } from "../../shared/errors/domain-errors.js";
import { removeUpload, UPLOAD_DIRS } from "../../shared/storage/uploads.js";

/** Carpeta física de los logotipos (servida en <origen API>/public/uploads/logos/…). */
export const LOGOS_DIR = UPLOAD_DIRS.logos;

/** Colores que usa una agencia sin fila en `agency_branding` (mismos defaults que la tabla). */
export const DEFAULT_BRANDING_COLORS = {
  primaryColor: "#4f46e5",
  secondaryColor: "#4338ca",
  accentColor: null,
} as const;

type BrandingColorsRow = {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string | null;
} | null;

/**
 * Identidad visual de la agencia para los comprobantes PDF:
 * - colores en `agency_branding` (1:1, se crea con upsert al guardar por primera vez);
 * - logotipo como archivo físico en `public/uploads/logos`, con su ruta en `agencies.logoPath`.
 */
export class AgencyBrandingService {
  /** Colores efectivos: los guardados o, si la agencia no tiene fila, los de por defecto. */
  static resolveColors(row: BrandingColorsRow | undefined) {
    return {
      primaryColor: row?.primaryColor ?? DEFAULT_BRANDING_COLORS.primaryColor,
      secondaryColor: row?.secondaryColor ?? DEFAULT_BRANDING_COLORS.secondaryColor,
      accentColor: row?.accentColor ?? DEFAULT_BRANDING_COLORS.accentColor,
    };
  }

  /** `{ logoPath, primaryColor, secondaryColor, accentColor }` o `null` si la agencia no existe. */
  static async getBranding(agencyId: string) {
    const agency = await db.query.agencies.findFirst({
      where: eq(agencies.id, agencyId),
      columns: { logoPath: true },
      with: {
        branding: { columns: { primaryColor: true, secondaryColor: true, accentColor: true } },
      },
    });
    if (!agency) return null;

    const colors = AgencyBrandingService.resolveColors(agency.branding);
    return {
      logoPath: agency.logoPath ?? null,
      primaryColor: colors.primaryColor,
      secondaryColor: colors.secondaryColor,
      accentColor: colors.accentColor,
    };
  }

  /** Upsert parcial de los colores: solo escribe los campos enviados. */
  static async updateColors(agencyId: string, body: UpdateBrandingBody) {
    const now = new Date().toISOString();
    const changes = {
      ...(body.primaryColor !== undefined ? { primaryColor: body.primaryColor } : {}),
      ...(body.secondaryColor !== undefined ? { secondaryColor: body.secondaryColor } : {}),
      ...(body.accentColor !== undefined ? { accentColor: body.accentColor } : {}),
    };

    await db
      .insert(agencyBranding)
      .values({ agencyId, ...changes })
      .onConflictDoUpdate({
        target: agencyBranding.agencyId,
        set: { ...changes, updatedAt: now },
      });

    return AgencyBrandingService.getBranding(agencyId);
  }

  /**
   * Reemplaza (o quita, con `null`) la ruta del logotipo y devuelve la anterior, para que la
   * ruta borre el archivo viejo solo después de que la base quedó actualizada.
   */
  static async setLogoPath(agencyId: string, logoPath: string | null) {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({ logoPath: agencies.logoPath })
        .from(agencies)
        .where(eq(agencies.id, agencyId))
        .for("update");
      if (!current) throw new NotFoundError("Agencia no encontrada");

      await tx
        .update(agencies)
        .set({ logoPath, updatedAt: new Date().toISOString() })
        .where(eq(agencies.id, agencyId));

      return { previousLogoPath: current.logoPath ?? null };
    });
  }

  /** Borra el archivo de un logotipo. Ignora rutas ajenas a `/uploads/logos/` y archivos faltantes. */
  static async removeLogoFile(logoPath: string | null) {
    await removeUpload("logos", logoPath);
  }
}
