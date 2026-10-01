import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { magicTokens } from "../../db/schema.js";

export class MagicTokenService {
  static async validate(tokenValue: string) {
    // 1. Buscar el token y traer la relación del tour y su agencia
    const magicToken = await db.query.magicTokens.findFirst({
      where: eq(magicTokens.token, tokenValue),
      with: {
        tour: {
          with: { agency: true },
        },
      },
    });

    if (!magicToken) {
      return {
        error: {
          code: "NOT_FOUND" as const,
          message: "El enlace mágico no existe o es incorrecto.",
        },
      };
    }

    if (new Date() > new Date(magicToken.expiresAt)) {
      return {
        error: {
          code: "EXPIRED" as const,
          message: "Este enlace ha superado su tiempo de validez. Solicita uno nuevo.",
        },
      };
    }

    // 2. Incremento atómico
    await db
      .update(magicTokens)
      .set({
        currentUses: sql`${magicTokens.currentUses} + 1`,
      })
      .where(eq(magicTokens.id, magicToken.id));

    // 3. Devolver datos limpios e hidratados para TourSummaryCard y BookingSuccessView
    return {
      isValid: true,
      data: {
        availableSeats: magicToken.tour.maxCapacity,
        tour: {
          id: magicToken.tour.id,
          title: magicToken.tour.title,
          departureDateTime: magicToken.tour.departureDateTime,

          // Finanzas (Conversión segura a Number asumiendo que Drizzle los trae como string decimales)
          priceTotalPerPassenger: Number(magicToken.tour.price),
          depositPerPassenger: magicToken.tour.depositPerPerson
            ? Number(magicToken.tour.depositPerPerson)
            : null,

          // Agencia y métodos de pago
          agency: {
            name: magicToken.tour.agency.name,
            phone: magicToken.tour.agency.phone,
            bankName: magicToken.tour.agency.bankName,
            accountHolder: magicToken.tour.agency.bankAccountHolder,
            clabeNumber: magicToken.tour.agency.clabeNumber,
          },
          acceptsBankTransfer: magicToken.tour.acceptsBankTransfer,
          acceptsCreditCard: magicToken.tour.acceptsCreditCard,
          paymentLink: magicToken.tour.paymentLink,

          boardingPoints: magicToken.tour.boardingPoints,
        },
      },
    };
  }
}
