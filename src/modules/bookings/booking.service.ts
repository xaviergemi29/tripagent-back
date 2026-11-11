import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { CreateBookingBody, CreateReservationBookingBody } from "./booking.schema.js";
import {
  bookingPassengers,
  bookings,
  magicTokens,
  PAYMENT_STATUS,
  tours,
  travelers,
} from "../../db/schema.js";
import nodeCrypto from "node:crypto";
import {
  deriveBookingStatus,
  getExpectedGroupSize,
  getRequiredDeposit,
} from "../../shared/utils/booking-rules.util.js";

/** Transacción de Drizzle (el `tx` que recibe el callback de `db.transaction`). */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const generateSecureToken = (length = 32): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

export class BookingService {
  /**
   * Recalcula el estado derivado PENDING ⇄ CONFIRMED de una reserva (ver deriveBookingStatus).
   * Debe llamarse dentro de la transacción, DESPUÉS de actualizar amountPaid, totalPrice o el
   * tamaño del grupo (magic token), para que lea los valores ya modificados.
   */
  static async syncConfirmationStatus(tx: DbTransaction, bookingId: string) {
    const booking = await tx.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      columns: { status: true, amountPaid: true, totalPrice: true },
      with: {
        tour: { columns: { price: true, depositPerPerson: true } },
        magicToken: { columns: { numberPassengers: true } },
      },
    });
    if (!booking) return;

    const groupSize = getExpectedGroupSize(
      booking.magicToken?.numberPassengers,
      Number(booking.totalPrice),
      Number(booking.tour.price),
    );
    const newStatus = deriveBookingStatus(
      booking.status,
      Number(booking.amountPaid),
      getRequiredDeposit(Number(booking.tour.depositPerPerson), groupSize),
    );

    if (newStatus !== booking.status) {
      await tx
        .update(bookings)
        .set({ status: newStatus, updatedAt: new Date().toISOString() })
        .where(eq(bookings.id, bookingId));
    }
  }

  static async processGroupBooking(data: CreateBookingBody) {
    const { token, ...payload } = data;

    return await db.transaction(async (tx) => {
      // 1. Validar el Token de Seguridad
      const magicToken = await tx.query.magicTokens.findFirst({
        where: eq(magicTokens.token, token),
      });

      if (!magicToken) throw new Error("Token inválido o no encontrado");

      const totalRequestedPassengers = 1 + (payload.hasCompanions ? payload.companions.length : 0);
      if (totalRequestedPassengers > magicToken.numberPassengers) {
        throw new Error(
          `Violación de integridad: Has intentado registrar ${totalRequestedPassengers} pasajeros, pero tu reserva solo ampara ${magicToken.numberPassengers} lugares.`,
        );
      }

      const agencyId = magicToken.agencyId;

      // 2. Encontrar el Tour
      const tour = await tx.query.tours.findFirst({
        where: eq(tours.id, magicToken.tourId),
        with: { agency: true },
      });
      if (!tour) throw new Error("Tour no encontrado");

      // 🚀 FIX 2: Obtener la reserva directamente desde el token (Evita fallos si hubo typos en el celular)
      const existingBooking = await tx.query.bookings.findFirst({
        where: eq(bookings.id, magicToken.bookingId),
      });

      if (!existingBooking || existingBooking.status === "CANCELLED") {
        throw new Error("Reserva no encontrada o previamente cancelada.");
      }

      // 3. Enriquecer al Titular (Find-or-Update)
      let mainTravelerId: string;
      const existingTitular = await tx.query.travelers.findFirst({
        where: and(
          eq(travelers.agencyId, agencyId),
          eq(travelers.whatsappPhone, payload.mainClient.whatsappPhone),
        ),
      });

      if (existingTitular) {
        await tx
          .update(travelers)
          .set({
            fullName: payload.mainClient.fullName,
            email: payload.mainClient.email,
            emergencyContactName: payload.mainClient.emergencyContactName,
            emergencyContactPhone: payload.mainClient.emergencyContactPhone,
            medicalNotes: payload.mainClient.medicalNotes,
            birthDate: payload.mainClient.birthDate,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(travelers.id, existingTitular.id));
        mainTravelerId = existingTitular.id;
      } else {
        const [newMain] = await tx
          .insert(travelers)
          .values({ agencyId, ...payload.mainClient })
          .returning({ id: travelers.id });
        if (!newMain) throw new Error("No se pudo crear el viajero");
        mainTravelerId = newMain.id;
      }

      if (existingBooking.travelerId !== mainTravelerId) {
        await tx
          .update(bookings)
          .set({ travelerId: mainTravelerId })
          .where(eq(bookings.id, existingBooking.id));
      }

      // Aseguramos el punto de abordaje del titular en el manifiesto
      await tx
        .update(bookingPassengers)
        .set({
          travelerId: mainTravelerId,
          boardingPoint: payload.mainClient.boardingPoint,
          passengerType: "ADULT",
        })
        .where(
          and(
            eq(bookingPassengers.bookingId, existingBooking.id),
            eq(bookingPassengers.isTitular, true), // Nos aseguramos de actualizar la fila maestra
          ),
        );

      // 4. Procesar Acompañantes
      const companionTravelerIds: string[] = [];
      const companionTypeMap = new Map<string, "ADULT" | "CHILD">();
      const companionBoardingMap = new Map<string, string>();

      if (
        payload.hasCompanions &&
        payload.companionMethod === "MANUAL" &&
        payload.companions.length > 0
      ) {
        for (const comp of payload.companions) {
          let compId: string;
          const existingComp = comp.whatsappPhone
            ? await tx.query.travelers.findFirst({
                where: and(
                  eq(travelers.agencyId, agencyId),
                  eq(travelers.whatsappPhone, comp.whatsappPhone),
                ),
              })
            : null;

          if (existingComp) {
            await tx
              .update(travelers)
              .set({
                fullName: comp.fullName,
                email: comp.email || "N/A",
                emergencyContactName: comp.emergencyContactName,
                emergencyContactPhone: comp.emergencyContactPhone,
                medicalNotes: comp.medicalNotes,
                birthDate: comp.birthDate,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(travelers.id, existingComp.id));
            compId = existingComp.id;
          } else {
            const [newComp] = await tx
              .insert(travelers)
              .values({
                agencyId,
                fullName: comp.fullName,
                whatsappPhone: comp.whatsappPhone,
                email: comp.email,
                emergencyContactName: comp.emergencyContactName,
                emergencyContactPhone: comp.emergencyContactPhone,
                medicalNotes: comp.medicalNotes,
                birthDate: comp.birthDate,
              })
              .returning({ id: travelers.id });
            compId = newComp.id;
          }
          companionTravelerIds.push(compId);
          companionTypeMap.set(compId, comp.passengerType);
          companionBoardingMap.set(compId, comp.boardingPoint);
        }
      }

      // 5. Agregar nuevos pasajeros al manifiesto
      const existingPassengers = await tx.query.bookingPassengers.findMany({
        where: eq(bookingPassengers.bookingId, existingBooking.id),
      });

      const passengerIdsInBus = existingPassengers.map((p) => p.travelerId);
      const newPassengersToInsert = companionTravelerIds.filter(
        (id) => !passengerIdsInBus.includes(id),
      );

      if (newPassengersToInsert.length > 0) {
        const existingCompanionsInTour = await tx.query.bookingPassengers.findFirst({
          where: and(
            inArray(bookingPassengers.travelerId, newPassengersToInsert),
            inArray(
              bookingPassengers.bookingId,
              tx
                .select({ id: bookings.id })
                .from(bookings)
                .where(and(eq(bookings.tourId, tour.id), ne(bookings.status, "CANCELLED"))),
            ),
          ),
        });

        if (existingCompanionsInTour) {
          throw new Error(
            "Uno de los acompañantes ingresados ya cuenta con un lugar en este tour bajo otra reserva.",
          );
        }

        const passengersData = newPassengersToInsert.map((travelerId) => ({
          bookingId: existingBooking.id,
          travelerId: travelerId,
          isTitular: false,
          passengerType: companionTypeMap.get(travelerId) || "ADULT",
          boardingPoint: companionBoardingMap.get(travelerId) || null,
        }));
        await tx.insert(bookingPassengers).values(passengersData);
      }

      // 6. Quemar uso del Token y Finalizar
      await tx
        .update(magicTokens)
        .set({ currentUses: magicToken.currentUses + 1 })
        .where(eq(magicTokens.id, magicToken.id));

      // El formulario quedó lleno: sale de AWAITING_REGISTRATION y el estado se deriva
      // (CONFIRMED si ya cubría el anticipo, p. ej. pagó antes de registrarse).
      await tx
        .update(bookings)
        .set({ status: "PENDING" })
        .where(eq(bookings.id, existingBooking.id));
      await BookingService.syncConfirmationStatus(tx, existingBooking.id);

      const companionNames: string[] =
        payload.companions?.map((c) => c.fullName.trim()).filter(Boolean) || [];

      return {
        bookingId: existingBooking.id,
        agencyName: tour.agency.name,
        agencyPhone: tour.agency.phone,
        titularName: payload.mainClient.fullName,
        companionNames,
        totalAmount: Number(existingBooking.totalPrice),
        depositAmount:
          tour.depositPerPerson > 0
            ? Number(tour.depositPerPerson) * totalRequestedPassengers
            : null,
        acceptsBankTransfer: tour.acceptsBankTransfer,
        bankName: tour.agency.bankName,
        accountHolder: tour.agency.bankAccountHolder,
        clabeNumber: tour.agency.clabeNumber,
        acceptsCreditCard: tour.acceptsCreditCard,
        paymentLink: tour.paymentLink,
        message: "Registro completado con éxito.",
      };
    });
  }
  static async createQuickBooking(
    tourId: string,
    data: CreateReservationBookingBody,
    agencyId: string,
  ) {
    const { numberPassengers, fullName, whatsapp, email } = data;

    return await db.transaction(async (tx) => {
      // 1. Validar existencia del Tour y su pertenencia a la agencia de la sesión (multi-tenant)
      const tour = await tx.query.tours.findFirst({
        where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId)),
      });

      if (!tour) throw new Error("Tour no encontrado");

      // 2. Control de Asientos Crítico (Capacidad)
      const [reservations] = await tx
        .select({ totalAsientos: count() })
        .from(bookings)
        .where(and(eq(bookings.tourId, tourId), ne(bookings.status, "CANCELLED")));

      const currentOccupancy = Number(reservations?.totalAsientos || 0);
      const availableSeats = tour.maxCapacity - currentOccupancy;

      if (numberPassengers > availableSeats) {
        throw new Error(`Capacidad excedida. Solo quedan ${availableSeats} lugares disponibles.`);
      }

      // 3. Find-or-Create del Viajero Titular (Obtenemos el titularId garantizado)
      let titularId: string;
      const existingTitular = await tx.query.travelers.findFirst({
        where: and(
          eq(travelers.agencyId, agencyId),
          eq(travelers.whatsappPhone, whatsapp),
          isNull(travelers.deletedAt),
        ),
      });

      if (existingTitular) {
        titularId = existingTitular.id;
      } else {
        const [newTitular] = await tx
          .insert(travelers)
          .values({
            agencyId,
            fullName,
            whatsappPhone: whatsapp,
            email,
            emergencyContactName: "",
            emergencyContactPhone: "",
          })
          .returning({ id: travelers.id });

        if (!newTitular) {
          throw new Error("Fallo crítico: No se pudo generar el ID del nuevo titular.");
        }

        titularId = newTitular.id;
      }

      // 4. Prevenir Doble Reserva (Ahora sí evaluamos con un titularId válido y existente)
      // 🛡️ OPCIÓN A: Validar que el viajero NO esté ya en el manifiesto de este tour en NINGUNA otra reserva activa
      const existingPassengerInTour = await tx.query.bookingPassengers.findFirst({
        where: and(
          eq(bookingPassengers.travelerId, titularId),
          inArray(
            bookingPassengers.bookingId,
            db
              .select({ id: bookings.id })
              .from(bookings)
              .where(and(eq(bookings.tourId, tourId), ne(bookings.status, "CANCELLED"))),
          ),
        ),
      });

      if (existingPassengerInTour) {
        throw new Error(
          "El viajero ya cuenta con una reserva activa o forma parte de un grupo en este tour.",
        );
      }

      // 5. Crear la Reserva (Booking PENDING)
      const groupReference = `GRP-${generateSecureToken(8).toUpperCase()}`;

      const [newBooking] = await tx
        .insert(bookings)
        .values({
          agencyId,
          tourId,
          travelerId: titularId,
          groupReference,
          totalPrice: Number(tour.price) * numberPassengers,
          amountPaid: 0,
          status: "AWAITING_REGISTRATION",
          paymentStatus: "PENDING",
        })
        .returning({ id: bookings.id });

      if (!newBooking) {
        throw new Error("Fallo crítico: No se pudo generar la reserva en la base de datos.");
      }

      // 6. Vincular al Titular al Manifiesto
      await tx.insert(bookingPassengers).values({
        bookingId: newBooking.id,
        travelerId: titularId,
        isTitular: true,
      });

      // 7. Generar el Magic Link Token
      const rawToken = nodeCrypto.randomUUID().replace(/-/g, "");
      // expiresAt es obligatorio en la BD, pero el enlace NO vence (decisión del PM): no se valida.
      const expires = new Date();
      expires.setHours(expires.getHours() + 48);

      await tx.insert(magicTokens).values({
        agencyId,
        tourId,
        bookingId: newBooking.id,
        token: rawToken,
        numberPassengers,
        currentUses: 1,
        expiresAt: expires.toISOString(),
      });

      return {
        bookingId: newBooking.id,
        token: rawToken,
        availableSeats: availableSeats - numberPassengers,
      };
    });
  }

  static async cancelBooking(bookingId: string, penaltyPercentage: number, agencyId: string) {
    return db.transaction(async (tx) => {
      // 1. PATRÓN FAIL-FAST (Falla rápido):
      // Buscamos la reserva y validamos estado antes de hacer cálculos pesados.
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking) throw new Error("Reserva no encontrada");
      // Máquina de estados: Una transición de CANCELLED a CANCELLED es inválida.
      if (booking.status === "CANCELLED") {
        throw new Error("La reserva ya se encuentra cancelada");
      }

      // 2. BATCH UPDATE (Actualización en lote)
      // EJEMPLO DE APRENDIZAJE: Un error común de un Junior sería hacer un query para
      // traer todos los pasajeros, iterarlos con un for/map, y hacer un update por cada uno.
      // En SQL, es infinitamente más rápido decirle al motor: "Actualiza a CANCELLED
      // a TODOS los que tengan este bookingId". Es 1 query vs N queries.

      await tx
        .update(bookingPassengers)
        .set({ status: "CANCELLED" })
        .where(eq(bookingPassengers.bookingId, bookingId));

      // 3. LÓGICA FINANCIERA (El core del negocio)
      const currentTotalPrice = Number(booking.totalPrice);
      const amountPaid = Number(booking.amountPaid);

      // ¿Cuánto de la deuda original vamos a "perdonar"?
      // Ejemplo 1 (100% penalización): Tour de $2,000. 100 - 100 = 0. Deduction = 0.
      // Ejemplo 2 (0% penalización): Tour de $2,000. 100 - 0 = 100. Deduction = $2,000.
      const deductionPercentage = (100 - penaltyPercentage) / 100;
      const deductionAmount = currentTotalPrice * deductionPercentage;

      const newTotalPrice = Math.max(0, currentTotalPrice - deductionAmount);

      // 4. MÁQUINA DE ESTADOS DEL PAGO
      let newPaymentStatus: (typeof PAYMENT_STATUS.enumValues)[number] = booking.paymentStatus;

      if (amountPaid >= newTotalPrice && newTotalPrice > 0) {
        newPaymentStatus = "PAID";
      } else if (newTotalPrice === 0 && amountPaid === 0) {
        // Si perdonamos toda la deuda y no habían dado ni un peso, el status de pago queda neutral
        newPaymentStatus = "PENDING";
      }

      // 5. ACTUALIZAR LA RAÍZ DEL AGREGADO (La Reserva)
      await tx
        .update(bookings)
        .set({
          status: "CANCELLED", // 👈 Liberamos los asientos para revenderlos
          totalPrice: newTotalPrice,
          paymentStatus: newPaymentStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      // 6. PREPARAR EL CONTEXTO PARA EL FRONT-END
      // El Front-End no debería calcular saldos, esa es responsabilidad del Back-End.
      const isOverpaid = amountPaid > newTotalPrice;
      const surplusAmount = isOverpaid ? amountPaid - newTotalPrice : 0;

      return {
        message: "Reserva cancelada exitosamente. Los asientos han sido liberados.",
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

  static async addPassengerToBooking(bookingId: string, tourId: string, agencyId: string) {
    return await db.transaction(async (tx) => {
      // 1. Validar la reserva maestra y su pertenencia a la agencia
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking || booking.status === "CANCELLED") {
        throw new Error("Reserva no encontrada o cancelada.");
      }

      // 2. Validar el Tour y la Capacidad Real del Vehículo
      const tour = await tx.query.tours.findFirst({
        where: eq(tours.id, tourId),
      });
      if (!tour) throw new Error("Tour no encontrado.");

      // Contar ocupación global activa en el tour de manera atómica
      const [occupancyResult] = await tx
        .select({ total: count() })
        .from(bookingPassengers)
        .innerJoin(bookings, eq(bookingPassengers.bookingId, bookings.id))
        .where(and(eq(bookings.tourId, tourId), ne(bookingPassengers.status, "CANCELLED")));

      const currentOccupancy = Number(occupancyResult?.total || 0);
      if (currentOccupancy >= tour.maxCapacity) {
        throw new Error("No hay lugares disponibles en el transporte. Capacidad máxima alcanzada.");
      }

      // 3. Obtener y actualizar el Token Mágico (Garantizando integridad obligatoria)
      const magicToken = await tx.query.magicTokens.findFirst({
        where: eq(magicTokens.bookingId, bookingId),
      });

      if (!magicToken) {
        throw new Error("No se encontró el token de acceso asociado a esta reserva.");
      }

      const updatedGroupSize = magicToken.numberPassengers + 1;

      await tx
        .update(magicTokens)
        .set({ numberPassengers: updatedGroupSize })
        .where(eq(magicTokens.id, magicToken.id));

      // 4. Ajuste Financiero: Sumar el precio unitario del tour
      const unitPrice = Number(tour.price);
      const newTotalPrice = Number(booking.totalPrice) + unitPrice;

      // Recalcular estatus de pago de forma atómica
      const amountPaid = Number(booking.amountPaid);
      let newPaymentStatus = booking.paymentStatus;

      if (amountPaid >= newTotalPrice && newTotalPrice > 0) {
        newPaymentStatus = "PAID";
      } else if (amountPaid > 0 && amountPaid < newTotalPrice) {
        newPaymentStatus = "PARTIAL";
      }

      await tx
        .update(bookings)
        .set({
          totalPrice: newTotalPrice,
          paymentStatus: newPaymentStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      // Más lugares = mayor anticipo requerido: una reserva confirmada puede volver a PENDING.
      await BookingService.syncConfirmationStatus(tx, bookingId);

      return {
        message: "Lugar agregado exitosamente al grupo.",
        newTotalPrice,
        newGroupSize: updatedGroupSize,
      };
    });
  }

  static async removePendingSlot(bookingId: string, agencyId: string) {
    return await db.transaction(async (tx) => {
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });
      if (!booking || booking.status === "CANCELLED")
        throw new Error("Reserva inválida o cancelada.");

      const magicToken = await tx.query.magicTokens.findFirst({
        where: eq(magicTokens.bookingId, bookingId),
      });
      if (!magicToken) throw new Error("Token no encontrado.");

      const activePassengersResult = await tx
        .select({ count: count() })
        .from(bookingPassengers)
        .where(
          and(eq(bookingPassengers.bookingId, bookingId), eq(bookingPassengers.status, "ACTIVE")),
        );
      const activePassengers = Number(activePassengersResult[0]?.count || 0);

      if (magicToken.numberPassengers <= activePassengers) {
        throw new Error("No hay lugares pendientes de registro para eliminar.");
      }

      const tour = await tx.query.tours.findFirst({ where: eq(tours.id, booking.tourId) });
      const unitPrice = Number(tour?.price || 0);

      // 1. Reducir la deuda y el tamaño del grupo
      const newTotalPrice = Math.max(0, Number(booking.totalPrice) - unitPrice);
      const amountPaid = Number(booking.amountPaid);

      // 2. 🚀 FIX: Recalcular la Máquina de Estados del Pago
      let newPaymentStatus = booking.paymentStatus;
      if (amountPaid >= newTotalPrice && newTotalPrice > 0) {
        newPaymentStatus = "PAID";
      } else if (amountPaid > 0 && amountPaid < newTotalPrice) {
        newPaymentStatus = "PARTIAL";
      } else if (newTotalPrice === 0 && amountPaid === 0) {
        newPaymentStatus = "PENDING";
      }

      await tx
        .update(magicTokens)
        .set({ numberPassengers: magicToken.numberPassengers - 1 })
        .where(eq(magicTokens.id, magicToken.id));

      await tx
        .update(bookings)
        .set({
          totalPrice: newTotalPrice,
          paymentStatus: newPaymentStatus, // 👈 Inyectamos el nuevo estado
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      // Menos lugares = menor anticipo requerido: puede pasar a CONFIRMED.
      await BookingService.syncConfirmationStatus(tx, bookingId);

      return { message: "Cupo pendiente liberado exitosamente", newTotalPrice, newPaymentStatus };
    });
  }

  static async cancelFullBooking(bookingId: string, penaltyAmount: number, agencyId: string) {
    return db.transaction(async (tx) => {
      // 1. Fail-Fast: Buscar reserva
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking) throw new Error("Reserva no encontrada");
      if (booking.status === "CANCELLED") {
        throw new Error("La reserva ya se encuentra cancelada");
      }

      const currentTotalPrice = Number(booking.totalPrice);
      const amountPaid = Number(booking.amountPaid);

      // 🛡️ 2. AUDITORÍA DE SEGURIDAD: Prevenir manipulación de montos desde el cliente
      if (penaltyAmount > currentTotalPrice) {
        throw new Error(
          "Violación de integridad: La penalización no puede superar el costo total original de la reserva.",
        );
      }

      // 3. Batch Update: Cancelar a todos los pasajeros vinculados de golpe (Evita N+1 queries)
      await tx
        .update(bookingPassengers)
        .set({
          status: "CANCELLED",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookingPassengers.bookingId, bookingId));

      // 4. Lógica Financiera Base:
      // Si la penalización es de $500, el nuevo costo total de los "servicios consumidos" es $500.
      const newTotalPrice = penaltyAmount;

      // 5. Máquina de Estados del Pago
      let newPaymentStatus: (typeof PAYMENT_STATUS.enumValues)[number] = booking.paymentStatus;

      if (amountPaid >= newTotalPrice && newTotalPrice > 0) {
        newPaymentStatus = "PAID";
      } else if (newTotalPrice === 0 && amountPaid === 0) {
        newPaymentStatus = "PENDING";
      } else if (amountPaid > 0 && amountPaid < newTotalPrice) {
        newPaymentStatus = "PARTIAL";
      }

      // 6. Persistencia del Agregado Raíz (Reserva)
      await tx
        .update(bookings)
        .set({
          status: "CANCELLED", // Libera los cupos
          totalPrice: newTotalPrice,
          paymentStatus: newPaymentStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      // 7. Contexto para Front-End (Saldos a favor)
      const isOverpaid = amountPaid > newTotalPrice;
      const surplusAmount = isOverpaid ? amountPaid - newTotalPrice : 0;

      return {
        message: "Reserva cancelada exitosamente. Se ha aplicado la retención solicitada.",
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
}
