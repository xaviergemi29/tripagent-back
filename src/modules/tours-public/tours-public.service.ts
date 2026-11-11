import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tours } from "../../db/schema.js";

export class TourBrochure {
  static async findTourBrochureById(tourId: string) {
    return db.query.tours.findFirst({
      where: and(eq(tours.id, tourId), isNull(tours.deletedAt), eq(tours.isActive, true)),
      columns: {
        id: true,
        title: true,
        currency: true,
        transportModality: true,
        price: true,
        depositPerPerson: true,
        departureDateTime: true,
        returnDate: true,
        brochureUrl: true,
        boardingPoints: true,
      },
      with: {
        agency: { columns: { name: true, phone: true } },
      },
    });
  }

  static async updateBrochureUrl(id: string, brochureUrl: string, agencyId: string) {
    const [updatedTour] = await db
      .update(tours)
      .set({ brochureUrl, updatedAt: new Date().toISOString() })
      .where(and(eq(tours.id, id), eq(tours.agencyId, agencyId), isNull(tours.deletedAt)))
      .returning();

    if (!updatedTour) throw new Error("Tour no encontrado o sin permisos");
    return updatedTour;
  }
}
