import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, tours } from "../../db/schema.js";

export class DashboardService {
    static async getTourDashboard(agencyId: string, tourId: string) {
        const tour = await db.query.tours.findFirst({
            where: and(
                eq(tours.id, tourId),
                eq(tours.agencyId, agencyId),
                isNull(tours.deletedAt)
            )
        });

        if (!tour) throw new Error("Tour no encontrado");

        // 2. Extraer reservas activas (EXCLUYENDO las canceladas por completo)
        const activeBookings = await db.query.bookings.findMany({
            where: and(
                eq(bookings.agencyId, agencyId),
                eq(bookings.tourId, tourId),
                ne(bookings.status, "CANCELLED"),
                isNull(bookings.deletedAt)
            ),
            with: {
                traveler: true, // Datos del Titular de la reserva
                passengers: {   // Manifiesto de abordaje (Titular + Acompañantes)
                    with: { traveler: true }
                },
                magicToken: true,
                payments: {
                    // Opcional pero recomendado: ordenar por fecha descendente
                    orderBy: (payments, { desc }) => [desc(payments.createdAt)],
                }
            }
        });

        let currentOccupancy = 0;
        let collectedRevenue = 0;
        let pendingValidationsCount = 0;
        let pendingFormsCount = 0;

        const groupedTravelers = [];

        for (const booking of activeBookings) {
            collectedRevenue += Number(booking.amountPaid || 0);

            const passengersList = booking.passengers || [];

            // 🛡️ FILTRO CLAVE: Solo contamos y procesamos pasajeros cuyo estatus sea ACTIVE
            const activePassengers = passengersList.filter(p => p.status === "ACTIVE");
            const activeCount = activePassengers.length;
            currentOccupancy += activePassengers.length;

            // Encontramos al titular dentro de los activos
            const titularRow = activePassengers.find(p => p.isTitular);

            // Si el titular canceló su parte o el grupo entero quedó sin titular activo, saltamos esta reserva
            if (!titularRow) continue;

            // Ya validamos arriba que activeCount es > 0, así que la división es segura.
            const unitPrice = Number(booking.totalPrice) / activeCount;

            // Acompañantes activos (excluimos al titular de esta lista)
            const companionsList = activePassengers.filter(p => !p.isTitular);

            // Verificamos formularios del titular
            const isTitularFormPending = !titularRow.traveler.emergencyContactPhone;
            if (isTitularFormPending) pendingFormsCount++;

            // Mapeamos a los acompañantes activos para el acordeón
            const mappedCompanions = companionsList.map(comp => {
                const isFormPending = !comp.traveler.emergencyContactPhone;
                if (isFormPending) pendingFormsCount++;
                return {
                    id: comp.traveler.id,
                    fullName: comp.traveler.fullName,
                    whatsapp: comp.traveler.whatsappPhone || "Sin teléfono",
                    role: "COMPANION",
                    paymentStatus: booking.paymentStatus,
                    paidAmount: 0,
                    balance: 0,
                    formStatus: isFormPending ? "PENDING" : "COMPLETED",
                    bookingId: booking.id,
                    unitPrice,
                    magicToken: booking.magicToken?.token
                };
            });

            const totalPrice = Number(booking.totalPrice);
            const amountPaid = Number(booking.amountPaid);
            // El balance nunca debe ser negativo (por si hay saldos a favor mal calculados)
            const balance = Math.max(0, totalPrice - amountPaid);

            const mappedPayments = (booking.payments || []).map(payment => ({
                id: payment.id,
                amount: Number(payment.amount),
                method: payment.method,
                type: payment.type,
                createdAt: payment.createdAt,
            }));

            // Empujamos al padre (Titular) con sus acompañantes activos
            groupedTravelers.push({
                id: titularRow.traveler.id,
                bookingId: booking.id,
                fullName: titularRow.traveler.fullName,
                whatsapp: titularRow.traveler.whatsappPhone || "Sin teléfono",
                role: "TITULAR",
                groupSize: activePassengers.length, // Tamaño real del grupo a bordo
                paymentStatus: booking.paymentStatus,
                paidAmount: Number(booking.amountPaid),
                balance,
                formStatus: isTitularFormPending ? "PENDING" : "COMPLETED",
                companions: mappedCompanions,
                unitPrice,
                magicToken: booking.magicToken?.token,
                payments: mappedPayments
            });
        }

        return {
            tourId: tour.id,
            title: tour.title,
            departureDateTime: tour.departureDateTime,
            metrics: {
                occupancy: { current: currentOccupancy, max: tour.maxCapacity },
                revenue: { projected: tour.maxCapacity * Number(tour.price), collected: collectedRevenue },
                pendingValidations: pendingValidationsCount,
                pendingForms: pendingFormsCount,
            },
            travelers: groupedTravelers
        };
    }
}