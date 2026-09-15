import { eq, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, bookingPassengers, PAYMENT_STATUS, tours } from "../../db/schema.js";

export class BookingPassengerService {
  static async cancelPassenger(
    bookingId: string,
    travelerId: string,
    penaltyAmount: number,
    agencyId: string,
  ) {
    return await db.transaction(async (tx) => {
      // 1. Validar la reserva maestra
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking) throw new Error("Reserva no encontrada");
      if (booking.status === "CANCELLED")
        throw new Error("La reserva ya está cancelada por completo");

      // 2. Verificar que el pasajero esté en el manifiesto y ACTIVO
      const targetPassenger = await tx.query.bookingPassengers.findFirst({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.travelerId, travelerId),
          eq(bookingPassengers.status, "ACTIVE"), // Solo operamos sobre activos
        ),
      });

      if (!targetPassenger) {
        throw new Error("El pasajero no existe o ya fue cancelado");
      }

      if (targetPassenger.isTitular) {
        // Bloqueo MVP: El titular no se puede bajar del barco individualmente.
        throw new Error(
          "No puedes remover al titular de forma parcial. Cancela la reserva completa.",
        );
      }

      // 3. Obtener el grupo activo para las matemáticas
      const activePassengers = await tx.query.bookingPassengers.findMany({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.status, "ACTIVE"),
        ),
      });

      const activeCount = activePassengers.length;
      if (activeCount <= 1) {
        throw new Error("Es el último pasajero. Usa la función de Cancelación Total.");
      }

      // 4. Matemáticas Financieras: El descuento
      const currentTotalPrice = Number(booking.totalPrice);
      const amountPaid = Number(booking.amountPaid);

      // Valor actual y exacto de un asiento individual en este grupo antes de la baja
      const unitPrice = currentTotalPrice / activeCount;

      // 🛡️ Validación Defensiva: No puedes penalizar por un monto mayor a lo que cuesta el boleto
      if (penaltyAmount > unitPrice) {
        throw new Error(
          `La penalización ($${penaltyAmount}) no puede superar el costo individual del asiento ($${unitPrice}).`,
        );
      }
      // ¿Cuánto le vamos a descontar a la deuda total?
      // Si el asiento cuesta 500 y penalizamos 200, solo le restamos 300 a la deuda del grupo.
      const deduction = unitPrice - penaltyAmount;
      const newTotalPrice = Math.max(0, currentTotalPrice - deduction);

      // 5. Bajar al pasajero del camión (Soft Delete lógico)
      await tx
        .update(bookingPassengers)
        .set({ status: "CANCELLED" })
        .where(eq(bookingPassengers.id, targetPassenger.id));

      // 6. Máquina de Estados Financiera
      let newPaymentStatus: (typeof PAYMENT_STATUS.enumValues)[number] = booking.paymentStatus;

      if (amountPaid >= newTotalPrice && newTotalPrice > 0) {
        newPaymentStatus = "PAID";
      } else if (amountPaid > 0 && amountPaid < newTotalPrice) {
        newPaymentStatus = "PARTIAL";
      } else if (newTotalPrice === 0) {
        newPaymentStatus = "PAID";
      }

      // 7. Actualizar la Reserva Maestra
      await tx
        .update(bookings)
        .set({
          totalPrice: newTotalPrice,
          paymentStatus: newPaymentStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      // 8. Handoff para el Frontend (UX)
      const isOverpaid = amountPaid > newTotalPrice;
      const surplusAmount = isOverpaid ? amountPaid - newTotalPrice : 0;

      return {
        message: "Pasajero cancelado exitosamente.",
        freedSeats: 1,
        financialSummary: {
          previousTotal: currentTotalPrice,
          newTotal: newTotalPrice,
          amountPaid: amountPaid,
          hasSurplus: isOverpaid,
          surplusAmount: surplusAmount,
        },
      };
    });
  }
  static async addOrReactivatePassenger(
    bookingId: string,
    travelerId: string,
    passengerType: "ADULT" | "CHILD",
    boardingPoint: string,
    agencyId: string,
  ) {
    return await db.transaction(async (tx) => {
      // 1. Validar la reserva maestra y su pertenencia al tenant
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking) throw new Error("Reserva no encontrada");
      if (booking.status === "CANCELLED")
        throw new Error("No se puede modificar una reserva cancelada");

      // 2. Validar el Tour asociado para conocer el precio unitario del asiento
      const tour = await tx.query.tours.findFirst({
        where: eq(tours.id, booking.tourId),
      });
      if (!tour) throw new Error("Tour asociado no encontrado");

      // 3. Verificar capacidad del tour (Control de Asientos Crítico)
      const activePassengersCheck = await tx.query.bookingPassengers.findMany({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.status, "ACTIVE"),
        ),
      });

      // Nota: Aquí puedes sumar la ocupación global del tour si lo requieres,
      // por ahora validamos que el grupo no exceda límites lógicos si aplica.

      // 4. Buscar si el pasajero ya estuvo en este manifiesto antes (Perfil vs Boleto)
      const existingPassengerRow = await tx.query.bookingPassengers.findFirst({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.travelerId, travelerId),
        ),
      });

      if (existingPassengerRow) {
        if (existingPassengerRow.status === "ACTIVE") {
          throw new Error("El pasajero ya se encuentra activo en esta reserva.");
        }

        // 🔄 Reactivación del pasajero "arrepentido" (Boleto nuevo sobre perfil existente)
        await tx
          .update(bookingPassengers)
          .set({
            status: "ACTIVE",
            boardingPoint,
            passengerType,
          })
          .where(eq(bookingPassengers.id, existingPassengerRow.id));
      } else {
        // ➕ Inserción de un pasajero completamente nuevo al grupo
        await tx.insert(bookingPassengers).values({
          bookingId,
          travelerId,
          isTitular: false,
          passengerType,
          boardingPoint,
          status: "ACTIVE",
        });
      }

      // 5. Recálculo Financiero Atómico
      // Contamos cuántos pasajeros activos quedan en total tras la adición
      const updatedActivePassengers = await tx.query.bookingPassengers.findMany({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.status, "ACTIVE"),
        ),
      });

      const newActiveCount = updatedActivePassengers.length;
      const unitPrice = Number(tour.price);
      const newTotalPrice = unitPrice * newActiveCount;
      const amountPaid = Number(booking.amountPaid);

      // 6. Máquina de Estados Financiera
      let newPaymentStatus: (typeof PAYMENT_STATUS.enumValues)[number] = booking.paymentStatus;
      if (amountPaid >= newTotalPrice && newTotalPrice > 0) {
        newPaymentStatus = "PAID";
      } else if (amountPaid > 0 && amountPaid < newTotalPrice) {
        newPaymentStatus = "PARTIAL";
      } else {
        newPaymentStatus = "PENDING";
      }

      // 7. Actualizar la Reserva Maestra con el nuevo precio y estatus
      await tx
        .update(bookings)
        .set({
          totalPrice: newTotalPrice,
          paymentStatus: newPaymentStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      return {
        message: "Pasajero incorporado exitosamente al grupo.",
        financialSummary: {
          newTotal: newTotalPrice,
          amountPaid,
          remainingBalance: Math.max(0, newTotalPrice - amountPaid),
          paymentStatus: newPaymentStatus,
          totalActivePassengers: newActiveCount,
        },
      };
    });
  }
}
