import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { magicTokens } from "../../db/schema.js";

export class MagicTokenService {
  static async validate(tokenValue: string) {
    // 1. Buscar el token
    const magicToken = await db.query.magicTokens.findFirst({
      where: eq(magicTokens.token, tokenValue),
      with: { tour: true },
    });

    // Validar existencia
    if (!magicToken) {
      return {
        error: {
          code: "NOT_FOUND" as const,
          message: "El enlace mágico no existe o es incorrecto.",
        },
      };
    }

    // Validar expiración de fecha
    if (new Date() > new Date(magicToken.expiresAt)) {
      return {
        error: {
          code: "EXPIRED" as const,
          message: "Este enlace ha superado su tiempo de validez. Solicita uno nuevo.",
        },
      };
    }

    // 🚀 2. INCREMENTAR TRACKING ATÓMICAMENTE (Background update o Fire-and-Forget)
    // Usamos sql`` para que PostgreSQL haga el incremento directamente
    await db
      .update(magicTokens)
      .set({
        currentUses: sql`${magicTokens.currentUses} + 1`,
      })
      .where(eq(magicTokens.id, magicToken.id));

    // 3. Devolver datos limpios
    return {
      isValid: true,
      data: {
        availableSeats: magicToken.tour.maxCapacity, // O tu cálculo de disponibilidad
        tour: {
          id: magicToken.tour.id,
          title: magicToken.tour.title,
          boardingPoints: magicToken.tour.boardingPoints,
        },
      },
    };
  }
}
