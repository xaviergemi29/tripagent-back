import { ilike, or, count, desc, eq, and, isNull, ne, sql, getTableColumns } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tours } from "../../db/schema.js";

export class TourBrochure {
  static async findTourBrochureById(tourId: string) {
    const tourBrochure = await db.query.tours.findFirst({
      where: eq(tours.id, tourId),
      with: {
        agency: true,
      },
    });

    if (!tourBrochure) throw new Error("Tour no encontrado");

    return tourBrochure;
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
