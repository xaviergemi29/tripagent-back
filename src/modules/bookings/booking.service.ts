import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/index.js";
import type {
  PublicRegisterBody,
  CreatePublicPreBookingBody,
  CreateReservationBookingBody,
  TransferPassengerBody,
} from "./booking.schema.js";
import {
  bookingPassengers,
  bookings,
  magicTokens,
  PAYMENT_STATUS,
  tours,
  travelers,
} from "../../db/schema.js";
import nodeCrypto from "node:crypto";
import { BookingStatusService } from "./booking-status.service.js";
import { BookingCapacityService } from "./booking-capacity.service.js";
import { lockBookingForUpdate } from "./booking-lock.util.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../../shared/errors/domain-errors.js";
import { getTourTemporalStatus } from "../../shared/utils/tour-status.util.js";
import { derivePaymentStatus } from "../../shared/utils/payment-status.util.js";
import {
  confirmLegacyPhone,
  fillEmptyTravelerFields,
} from "../../shared/utils/traveler-merge.util.js";
import { isSamePhone, phoneLookupCandidates } from "../../shared/utils/phone.util.js";
import type { CountryCode } from "libphonenumber-js";
import { PASSENGER_ROLE, TOUR_TEMPORAL_STATUS } from "../../shared/constants/domain.constants.js";

/**
 * Referencia legible del grupo (`GRP-XXXXXXXX`). Usa el generador criptográfico (antes
 * `Math.random`, predecible); no es un secreto, pero así no se pueden adivinar ni repetir en serie.
 */
const generateGroupReference = (length = 8): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) result += chars.charAt(nodeCrypto.randomInt(chars.length));
  return `GRP-${result}`;
};

/** Token del Magic Link: 128 bits aleatorios (UUID v4 sin guiones). */
const generateMagicToken = (): string => nodeCrypto.randomUUID().replace(/-/g, "");

/** Datos mínimos para apartar lugares (apartado rápido del operador o pre-reserva del folleto). */
interface ReserveSeatsInput {
  fullName: string;
  /** E.164 (el schema ya lo normalizó). */
  whatsapp: string;
  /** País del número; `null`/`undefined` = sin confirmar (cliente anterior al selector de lada). */
  whatsappCountry: CountryCode | null | undefined;
  email: string | null;
  numberPassengers: number;
}

/** Mensaje común cuando se intenta operar un tour cancelado por la agencia. */
export const TOUR_CANCELLED_ERROR =
  "El tour fue cancelado por la agencia: ya no admite reservas ni cambios de lugares.";
export class BookingService {
  /**
   * Registro del grupo desde el Magic Link (`POST /bookings/public/register`). El tenant sale del
   * token, nunca del cliente. El schema exige `privacyNoticeAccepted: true` (regla 19).
   */
  static async processGroupBooking(data: PublicRegisterBody) {
    // `privacyNoticeAccepted` siempre es `true` (z.literal): no se guarda tal cual, sino su fecha.
    const { token, privacyNoticeAccepted: _accepted, ...payload } = data;

    return db.transaction(async (tx) => {
      // 1. Validar el Token de Seguridad
      const magicToken = await tx.query.magicTokens.findFirst({
        where: eq(magicTokens.token, token),
      });

      if (!magicToken?.bookingId) throw new NotFoundError("Token inválido o no encontrado");
      const bookingId = magicToken.bookingId;

      const totalRequestedPassengers = 1 + (payload.hasCompanions ? payload.companions.length : 0);
      if (totalRequestedPassengers > magicToken.numberPassengers) {
        throw new BusinessRuleError(
          `Violación de integridad: Has intentado registrar ${totalRequestedPassengers} pasajeros, pero tu reserva solo ampara ${magicToken.numberPassengers} lugares.`,
        );
      }

      const agencyId = magicToken.agencyId;

      // 2. Encontrar el Tour
      const tour = await tx.query.tours.findFirst({
        where: eq(tours.id, magicToken.tourId),
        with: { agency: true },
      });
      if (!tour) throw new NotFoundError("Tour no encontrado");

      // 🚀 FIX 2: Obtener la reserva directamente desde el token (Evita fallos si hubo typos en el celular)
      const existingBooking = await tx.query.bookings.findFirst({
        where: eq(bookings.id, bookingId),
      });

      if (!existingBooking || existingBooking.status === "CANCELLED") {
        throw new NotFoundError("Reserva no encontrada o previamente cancelada.");
      }

      // Seguridad: el formulario solo se llena una vez. El Magic Link no vence, así que sin este
      // candado quien tuviera el enlace podría reenviar el registro en cualquier momento (incluso
      // pagado) para reasignar al titular, sobrescribir datos de otro cliente de la agencia
      // (find-or-update por teléfono) o agregar acompañantes por encima de los lugares apartados.
      // Los cambios posteriores los hace el operador (transferir, agregar o liberar lugares).
      if (existingBooking.status !== "AWAITING_REGISTRATION") {
        throw new ConflictError(
          "Esta reserva ya fue registrada. Si necesitas cambiar algún dato, contacta a tu agencia.",
        );
      }

      // 3. Enriquecer al Titular (Find-or-Update)
      let mainTravelerId: string;
      // Mismo criterio que el índice único (agencia, WhatsApp) de viajeros NO borrados: antes un
      // viajero dado de baja podía quedar como titular de la reserva (invisible en el CRM).
      const existingTitular = await tx.query.travelers.findFirst({
        where: and(
          eq(travelers.agencyId, agencyId),
          // E.164 y, mientras convivan, los 10 dígitos anteriores del mismo número.
          inArray(travelers.whatsappPhone, phoneLookupCandidates(payload.mainClient.whatsappPhone)),
          isNull(travelers.deletedAt),
        ),
      });

      if (existingTitular) {
        // Solo se completan los campos vacíos del perfil (decisión del PM, 2026-11-14) y, si el
        // número era anterior al selector de lada, se confirma con el país que eligió el cliente.
        const patch = {
          ...fillEmptyTravelerFields(existingTitular, payload.mainClient),
          ...confirmLegacyPhone(existingTitular, payload.mainClient),
        };
        if (Object.keys(patch).length > 0) {
          await tx
            .update(travelers)
            .set({ ...patch, updatedAt: new Date().toISOString() })
            .where(eq(travelers.id, existingTitular.id));
        }
        mainTravelerId = existingTitular.id;
      } else {
        const [newMain] = await tx
          .insert(travelers)
          .values({ agencyId, ...payload.mainClient })
          .returning({ id: travelers.id });
        if (!newMain) throw new Error("No se pudo crear el viajero");
        mainTravelerId = newMain.id;
      }

      await tx
        .update(bookings)
        .set({
          travelerId: mainTravelerId,
          // Constancia de la aceptación del aviso de privacidad (LFPDPPP).
          privacyNoticeAcceptedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, existingBooking.id));

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
                  inArray(travelers.whatsappPhone, phoneLookupCandidates(comp.whatsappPhone)),
                  isNull(travelers.deletedAt),
                ),
              })
            : null;

          if (existingComp) {
            // Solo se completan los campos vacíos del perfil (decisión del PM, 2026-11-14).
            const patch = {
              ...fillEmptyTravelerFields(existingComp, comp),
              ...confirmLegacyPhone(existingComp, comp),
            };
            if (Object.keys(patch).length > 0) {
              await tx
                .update(travelers)
                .set({ ...patch, updatedAt: new Date().toISOString() })
                .where(eq(travelers.id, existingComp.id));
            }
            compId = existingComp.id;
          } else {
            const [newComp] = await tx
              .insert(travelers)
              .values({
                agencyId,
                fullName: comp.fullName,
                whatsappPhone: comp.whatsappPhone,
                whatsappCountry: comp.whatsappPhone ? (comp.whatsappCountry ?? null) : null,
                email: comp.email,
                emergencyContactName: comp.emergencyContactName,
                emergencyContactPhone: comp.emergencyContactPhone,
                emergencyContactCountry: comp.emergencyContactCountry ?? null,
                medicalNotes: comp.medicalNotes,
                birthDate: comp.birthDate,
              })
              .returning({ id: travelers.id });
            if (!newComp) throw new Error("No se pudo crear el acompañante");
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
          throw new ConflictError(
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
      await BookingStatusService.syncStatus(tx, existingBooking.id, { formCompleted: true });

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
  /** Apartado rápido del operador (sesión): el tour debe ser de su agencia. */
  static async createQuickBooking(
    tourId: string,
    data: CreateReservationBookingBody,
    agencyId: string,
  ) {
    return db.transaction(async (tx) => {
      const tour = await tx.query.tours.findFirst({
        where: and(eq(tours.id, tourId), eq(tours.agencyId, agencyId)),
        columns: { id: true, agencyId: true, price: true, cancelledAt: true },
      });
      if (!tour) throw new NotFoundError("Tour no encontrado");
      // Un tour cancelado por la agencia ya no vende (Modo Auditoría, regla 9).
      if (tour.cancelledAt) throw new ConflictError(TOUR_CANCELLED_ERROR);

      return BookingService.reserveSeats(tx, tour, {
        fullName: data.fullName,
        whatsapp: data.whatsapp,
        whatsappCountry: data.whatsappCountry,
        email: data.email,
        numberPassengers: data.numberPassengers,
      });
    });
  }

  /**
   * Pre-reserva pública desde el folleto. Nace igual que un apartado rápido
   * (AWAITING_REGISTRATION + Magic Link); el operador comparte el enlace por WhatsApp.
   * No devuelve el token ni identificadores al cliente.
   */
  static async createPublicPreBooking(data: CreatePublicPreBookingBody): Promise<void> {
    return db.transaction(async (tx) => {
      const tour = await tx.query.tours.findFirst({
        where: and(eq(tours.id, data.tourId), isNull(tours.deletedAt), isNull(tours.cancelledAt)),
        columns: {
          id: true,
          agencyId: true,
          price: true,
          departureDateTime: true,
          returnDate: true,
          cancelledAt: true,
        },
      });
      if (!tour) throw new NotFoundError("Tour no encontrado");

      if (
        getTourTemporalStatus(tour.departureDateTime, tour.cancelledAt, tour.returnDate) !==
        TOUR_TEMPORAL_STATUS.UPCOMING
      ) {
        throw new ConflictError("Este tour ya no admite reservas en línea.");
      }

      await BookingService.reserveSeats(tx, tour, {
        fullName: data.fullName,
        whatsapp: data.whatsapp,
        whatsappCountry: data.whatsappCountry,
        email: null,
        numberPassengers: data.numberPassengers,
      });
    });
  }

  /**
   * Lógica común de apartado (operador y folleto), dentro de la transacción del llamador:
   * cupo atómico → titular find-or-create → anti-duplicado → reserva + manifiesto + Magic Link.
   */
  private static async reserveSeats(
    tx: DbTransaction,
    tour: { id: string; agencyId: string; price: number },
    data: ReserveSeatsInput,
  ) {
    const { numberPassengers, fullName, whatsapp, whatsappCountry, email } = data;

    // 1. Cupo atómico (bloquea la fila del tour hasta el commit) → 409 si no alcanza.
    const { availableSeats } = await BookingCapacityService.assertSeatsAvailable(
      tx,
      tour.id,
      numberPassengers,
    );

    // 2. Find-or-Create del titular. Un viajero existente NO se modifica.
    let titularId: string;
    const existingTitular = await tx.query.travelers.findFirst({
      where: and(
        eq(travelers.agencyId, tour.agencyId),
        inArray(travelers.whatsappPhone, phoneLookupCandidates(whatsapp)),
        isNull(travelers.deletedAt),
      ),
    });

    if (existingTitular) {
      titularId = existingTitular.id;
    } else {
      const [newTitular] = await tx
        .insert(travelers)
        .values({
          agencyId: tour.agencyId,
          fullName,
          whatsappPhone: whatsapp,
          whatsappCountry: whatsappCountry ?? null,
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

    // 3. El viajero no puede estar ya en el manifiesto de otra reserva activa de este tour.
    const existingPassengerInTour = await tx.query.bookingPassengers.findFirst({
      where: and(
        eq(bookingPassengers.travelerId, titularId),
        inArray(
          bookingPassengers.bookingId,
          tx
            .select({ id: bookings.id })
            .from(bookings)
            .where(and(eq(bookings.tourId, tour.id), ne(bookings.status, "CANCELLED"))),
        ),
      ),
    });

    if (existingPassengerInTour) {
      throw new ConflictError("Ya existe una reserva activa con este WhatsApp para este tour.");
    }

    // 4. Reserva (precio congelado) + titular en el manifiesto + Magic Link.
    const [newBooking] = await tx
      .insert(bookings)
      .values({
        agencyId: tour.agencyId,
        tourId: tour.id,
        travelerId: titularId,
        groupReference: generateGroupReference(),
        totalPrice: Number(tour.price) * numberPassengers,
        amountPaid: 0,
        status: "AWAITING_REGISTRATION",
        paymentStatus: "PENDING",
      })
      .returning({ id: bookings.id });

    if (!newBooking) {
      throw new Error("Fallo crítico: No se pudo generar la reserva en la base de datos.");
    }

    await tx.insert(bookingPassengers).values({
      bookingId: newBooking.id,
      travelerId: titularId,
      isTitular: true,
    });

    const rawToken = generateMagicToken();
    // expiresAt es obligatorio en la BD, pero el enlace NO vence (decisión del PM): no se valida.
    const expires = new Date();
    expires.setHours(expires.getHours() + 48);

    await tx.insert(magicTokens).values({
      agencyId: tour.agencyId,
      tourId: tour.id,
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
  }

  /**
   * Cancelación total con penalización en PORCENTAJE (`PATCH /bookings/:id/cancel`; el front usa
   * `cancel-full` con monto). Delega en `applyFullCancellation`, la única implementación: antes
   * duplicaba la lógica y no liberaba los asientos (`seatLabel`) de los pasajeros cancelados.
   * Penalización = total × % / 100 (misma fórmula que antes).
   */
  static async cancelBooking(bookingId: string, penaltyPercentage: number, agencyId: string) {
    return db.transaction(async (tx) => {
      await lockBookingForUpdate(tx, bookingId, agencyId);
      const booking = await tx.query.bookings.findFirst({
        where: and(
          eq(bookings.id, bookingId),
          eq(bookings.agencyId, agencyId),
          isNull(bookings.deletedAt),
        ),
      });

      if (!booking) throw new NotFoundError("Reserva no encontrada");
      if (booking.status === "CANCELLED") {
        throw new ConflictError("La reserva ya se encuentra cancelada");
      }

      const penaltyAmount =
        Math.round(Number(booking.totalPrice) * (penaltyPercentage / 100) * 100) / 100;
      const financialSummary = await BookingService.applyFullCancellation(
        tx,
        booking,
        penaltyAmount,
      );

      return {
        message: "Reserva cancelada exitosamente. Los asientos han sido liberados.",
        financialSummary,
      };
    });
  }

  static async addPassengerToBooking(bookingId: string, tourId: string, agencyId: string) {
    return db.transaction(async (tx) => {
      // 1. Validar la reserva maestra y su pertenencia a la agencia
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking || booking.status === "CANCELLED") {
        throw new NotFoundError("Reserva no encontrada o cancelada.");
      }

      // 2. El tour es SIEMPRE el de la reserva; un tourId distinto en el body se rechaza.
      if (tourId !== booking.tourId) {
        throw new BusinessRuleError("El tour indicado no corresponde a la reserva.");
      }
      const tour = await tx.query.tours.findFirst({
        where: eq(tours.id, booking.tourId),
        columns: { price: true },
      });
      if (!tour) throw new NotFoundError("Tour no encontrado.");

      // Cupo atómico con la misma regla que el apartado (bloquea el tour) → 409 si está lleno.
      await BookingCapacityService.assertSeatsAvailable(tx, booking.tourId, 1);
      // Después del tour (mismo orden que cancelTour, sin interbloqueos) se bloquea la reserva y se
      // relee su total: un abono o una baja simultáneos ya quedaron confirmados.
      await lockBookingForUpdate(tx, bookingId, agencyId);
      const lockedBooking = await tx.query.bookings.findFirst({
        where: eq(bookings.id, bookingId),
        columns: { status: true, totalPrice: true, amountPaid: true, paymentStatus: true },
      });
      if (!lockedBooking || lockedBooking.status === "CANCELLED") {
        throw new NotFoundError("Reserva no encontrada o cancelada.");
      }

      // 3. Obtener y actualizar el Token Mágico (Garantizando integridad obligatoria)
      const magicToken = await tx.query.magicTokens.findFirst({
        where: eq(magicTokens.bookingId, bookingId),
      });

      if (!magicToken) {
        throw new BusinessRuleError("No se encontró el token de acceso asociado a esta reserva.");
      }

      const updatedGroupSize = magicToken.numberPassengers + 1;

      await tx
        .update(magicTokens)
        .set({ numberPassengers: updatedGroupSize })
        .where(eq(magicTokens.id, magicToken.id));

      // 4. Ajuste Financiero: Sumar el precio unitario del tour
      const unitPrice = Number(tour.price);
      const newTotalPrice = Number(lockedBooking.totalPrice) + unitPrice;

      // Estado de pago con la regla única (`derivePaymentStatus`).
      const newPaymentStatus = derivePaymentStatus({
        amountPaid: lockedBooking.amountPaid,
        totalPrice: newTotalPrice,
        hasRefund: lockedBooking.paymentStatus === "REFUNDED",
      });

      await tx
        .update(bookings)
        .set({
          totalPrice: newTotalPrice,
          paymentStatus: newPaymentStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, bookingId));

      // Más lugares = mayor anticipo requerido: una reserva confirmada puede volver a PENDING.
      await BookingStatusService.syncStatus(tx, bookingId);

      return {
        message: "Lugar agregado exitosamente al grupo.",
        newTotalPrice,
        newGroupSize: updatedGroupSize,
      };
    });
  }

  static async removePendingSlot(bookingId: string, agencyId: string) {
    return db.transaction(async (tx) => {
      await lockBookingForUpdate(tx, bookingId, agencyId);
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });
      if (!booking || booking.status === "CANCELLED")
        throw new NotFoundError("Reserva inválida o cancelada.");

      const magicToken = await tx.query.magicTokens.findFirst({
        where: eq(magicTokens.bookingId, bookingId),
      });
      if (!magicToken) throw new BusinessRuleError("Token no encontrado.");

      const activePassengersResult = await tx
        .select({ count: count() })
        .from(bookingPassengers)
        .where(
          and(eq(bookingPassengers.bookingId, bookingId), eq(bookingPassengers.status, "ACTIVE")),
        );
      const activePassengers = Number(activePassengersResult[0]?.count || 0);

      if (magicToken.numberPassengers <= activePassengers) {
        throw new BusinessRuleError("No hay lugares pendientes de registro para eliminar.");
      }

      const tour = await tx.query.tours.findFirst({
        where: eq(tours.id, booking.tourId),
        columns: { price: true },
      });
      const unitPrice = Number(tour?.price || 0);

      // 1. Reducir la deuda y el tamaño del grupo
      const newTotalPrice = Math.max(0, Number(booking.totalPrice) - unitPrice);

      // 2. Estado de pago con la regla única (`derivePaymentStatus`).
      const newPaymentStatus = derivePaymentStatus({
        amountPaid: booking.amountPaid,
        totalPrice: newTotalPrice,
        hasRefund: booking.paymentStatus === "REFUNDED",
      });

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
      await BookingStatusService.syncStatus(tx, bookingId);

      return { message: "Cupo pendiente liberado exitosamente", newTotalPrice, newPaymentStatus };
    });
  }

  static async cancelFullBooking(bookingId: string, penaltyAmount: number, agencyId: string) {
    return db.transaction(async (tx) => {
      // Candado: una cancelación simultánea a un abono no deja el total desfasado.
      await lockBookingForUpdate(tx, bookingId, agencyId);
      // 1. Fail-Fast: Buscar reserva
      const booking = await tx.query.bookings.findFirst({
        where: and(eq(bookings.id, bookingId), eq(bookings.agencyId, agencyId)),
      });

      if (!booking) throw new NotFoundError("Reserva no encontrada");
      if (booking.status === "CANCELLED") {
        throw new ConflictError("La reserva ya se encuentra cancelada");
      }

      const financialSummary = await BookingService.applyFullCancellation(
        tx,
        booking,
        penaltyAmount,
      );

      return {
        message: "Reserva cancelada exitosamente. Se ha aplicado la retención solicitada.",
        financialSummary,
      };
    });
  }

  /**
   * Cancela una reserva completa dentro de una transacción en curso: todos los pasajeros pasan a
   * CANCELLED sin asiento y el total queda en la penalización. Única implementación, la usan
   * `cancelFullBooking` (operador, con penalización) y `TourService.cancelTour` (la agencia cancela
   * el tour: penalización $0, se reembolsa todo).
   */
  static async applyFullCancellation(
    tx: DbTransaction,
    booking: {
      id: string;
      totalPrice: number | string;
      amountPaid: number | string;
      paymentStatus: (typeof PAYMENT_STATUS.enumValues)[number];
    },
    penaltyAmount: number,
  ) {
    const currentTotalPrice = Number(booking.totalPrice);
    const amountPaid = Number(booking.amountPaid);

    // 🛡️ Prevenir manipulación de montos desde el cliente
    if (penaltyAmount > currentTotalPrice) {
      throw new BusinessRuleError(
        "Violación de integridad: La penalización no puede superar el costo total original de la reserva.",
      );
    }

    // Cancelar a todos los pasajeros de golpe (evita N+1) y liberar su asiento.
    await tx
      .update(bookingPassengers)
      .set({
        status: "CANCELLED",
        seatLabel: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(bookingPassengers.bookingId, booking.id));

    // Si la penalización es de $500, el nuevo costo total de los "servicios consumidos" es $500.
    const newTotalPrice = penaltyAmount;

    // Estado de pago con la regla única: con lo abonado ≥ retención queda PAID (con saldo a favor
    // si abonó de más); antes, con retención $0 y dinero abonado se quedaba el estado anterior.
    const newPaymentStatus = derivePaymentStatus({
      amountPaid,
      totalPrice: newTotalPrice,
      hasRefund: booking.paymentStatus === "REFUNDED",
    });

    await tx
      .update(bookings)
      .set({
        status: "CANCELLED", // Libera los cupos
        totalPrice: newTotalPrice,
        paymentStatus: newPaymentStatus,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(bookings.id, booking.id));

    // Saldo a favor del cliente (lo que hay que reembolsar).
    const isOverpaid = amountPaid > newTotalPrice;
    return {
      previousTotal: currentTotalPrice,
      newTotal: newTotalPrice,
      amountPaid,
      hasSurplus: isOverpaid,
      surplusAmount: isOverpaid ? amountPaid - newTotalPrice : 0,
    };
  }

  /**
   * Transferencia de un lugar (titular o acompañante) a otra persona (decisión del PM).
   * El lugar se conserva: asiento, precio, abonos y saldo no cambian. Solo se re-vincula la fila de
   * `booking_passengers` (y `bookings.travelerId` si es el titular) a otro viajero del CRM:
   * - WhatsApp → find-or-create por (agencia, WhatsApp); menor sin WhatsApp → viajero nuevo.
   * - El viajero original NO se modifica: su historial y sus notas médicas nunca pasan al nuevo.
   * - Titular con WhatsApp distinto → hereda el saldo y se regenera `magic_tokens.token`
   *   (el enlace anterior deja de funcionar).
   * No cambia dinero, cupo ni tamaño de grupo, así que no requiere `syncStatus`.
   */
  static async transferPassenger(bookingId: string, data: TransferPassengerBody, agencyId: string) {
    return db.transaction(async (tx) => {
      const booking = await tx.query.bookings.findFirst({
        where: and(
          eq(bookings.id, bookingId),
          eq(bookings.agencyId, agencyId),
          isNull(bookings.deletedAt),
        ),
      });
      if (!booking) throw new NotFoundError("Reserva no encontrada");
      if (booking.status === "CANCELLED") {
        throw new ConflictError("No se puede transferir un lugar de una reserva cancelada.");
      }

      const slot = await tx.query.bookingPassengers.findFirst({
        where: and(
          eq(bookingPassengers.bookingId, bookingId),
          eq(bookingPassengers.travelerId, data.passengerId),
          eq(bookingPassengers.status, "ACTIVE"),
        ),
        with: { traveler: true },
      });
      if (!slot) throw new NotFoundError("Pasajero no encontrado en esta reserva");

      const isTitular = data.role === PASSENGER_ROLE.TITULAR;
      if (slot.isTitular !== isTitular) {
        throw new BusinessRuleError(
          isTitular
            ? "El pasajero indicado no es el titular de la reserva."
            : "El pasajero indicado es el titular: usa la transferencia de titular.",
        );
      }

      const now = new Date().toISOString();
      const whatsapp = data.whatsapp ?? null;
      const email = data.isMinor ? null : (data.email ?? null);

      // 1. Resolver el viajero destino (find-or-create). Nunca se renombra al viajero original.
      const existingTraveler = whatsapp
        ? await tx.query.travelers.findFirst({
            where: and(
              eq(travelers.agencyId, agencyId),
              inArray(travelers.whatsappPhone, phoneLookupCandidates(whatsapp)),
              isNull(travelers.deletedAt),
            ),
          })
        : undefined;

      let targetTravelerId: string;
      if (existingTraveler) {
        // Datos capturados por el operador; los médicos solo se tocan si llegan en el acordeón.
        await tx
          .update(travelers)
          .set({
            fullName: data.fullName,
            email,
            ...confirmLegacyPhone(existingTraveler, {
              whatsappPhone: whatsapp,
              whatsappCountry: data.whatsappCountry,
            }),
            ...(data.medicalNotes !== undefined && { medicalNotes: data.medicalNotes }),
            ...(data.emergencyContactName !== undefined && {
              emergencyContactName: data.emergencyContactName,
            }),
            ...(data.emergencyContactPhone !== undefined && {
              emergencyContactPhone: data.emergencyContactPhone,
              emergencyContactCountry: data.emergencyContactCountry ?? null,
            }),
            updatedAt: now,
          })
          .where(eq(travelers.id, existingTraveler.id));
        targetTravelerId = existingTraveler.id;
      } else {
        // Viajero nuevo: arranca sin notas médicas heredadas (solo las capturadas, si hay).
        const [newTraveler] = await tx
          .insert(travelers)
          .values({
            agencyId,
            fullName: data.fullName,
            whatsappPhone: whatsapp,
            whatsappCountry: whatsapp ? (data.whatsappCountry ?? null) : null,
            email,
            medicalNotes: data.medicalNotes ?? null,
            emergencyContactName: data.emergencyContactName ?? "",
            emergencyContactPhone: data.emergencyContactPhone ?? "",
            emergencyContactCountry: data.emergencyContactPhone
              ? (data.emergencyContactCountry ?? null)
              : null,
          })
          .returning({ id: travelers.id });
        if (!newTraveler) throw new Error("No se pudo crear el viajero");
        targetTravelerId = newTraveler.id;
      }

      const isNewPerson = targetTravelerId !== slot.travelerId;

      // 2. Anti-duplicado: el nuevo viajero no puede estar activo en este tour (ninguna reserva).
      if (isNewPerson) {
        const alreadyInTour = await tx.query.bookingPassengers.findFirst({
          where: and(
            eq(bookingPassengers.travelerId, targetTravelerId),
            eq(bookingPassengers.status, "ACTIVE"),
            inArray(
              bookingPassengers.bookingId,
              tx
                .select({ id: bookings.id })
                .from(bookings)
                .where(and(eq(bookings.tourId, booking.tourId), ne(bookings.status, "CANCELLED"))),
            ),
          ),
        });
        if (alreadyInTour) {
          throw new ConflictError("Esta persona ya tiene un lugar activo en este tour.");
        }
      }

      // 3. Punto de abordaje: el acompañante puede heredar el del titular.
      let boardingPoint = slot.boardingPoint;
      if (!isTitular && data.inheritTitularBoardingPoint) {
        const titularSlot = await tx.query.bookingPassengers.findFirst({
          where: and(
            eq(bookingPassengers.bookingId, bookingId),
            eq(bookingPassengers.isTitular, true),
            eq(bookingPassengers.status, "ACTIVE"),
          ),
        });
        boardingPoint = titularSlot?.boardingPoint ?? slot.boardingPoint;
      }

      // 4. Re-vincular el lugar (el asiento se conserva).
      await tx
        .update(bookingPassengers)
        .set({
          travelerId: targetTravelerId,
          passengerType: data.isMinor ? "CHILD" : "ADULT",
          boardingPoint,
          updatedAt: now,
        })
        .where(eq(bookingPassengers.id, slot.id));

      // 5. Titular: hereda el saldo (la reserva cambia de dueño) y, si el WhatsApp cambió,
      //    se regenera el Magic Link para que el titular anterior pierda el acceso.
      let tokenRegenerated = false;
      if (isTitular) {
        if (isNewPerson) {
          await tx
            .update(bookings)
            .set({ travelerId: targetTravelerId, updatedAt: now })
            .where(eq(bookings.id, bookingId));
        }
        // Se comparan números normalizados: el guardado puede seguir en los 10 dígitos anteriores
        // y el capturado llega en E.164; compararlos como texto regeneraba el token por error.
        if (!isSamePhone(whatsapp, slot.traveler.whatsappPhone)) {
          await tx
            .update(magicTokens)
            .set({ token: generateMagicToken() })
            .where(eq(magicTokens.bookingId, bookingId));
          tokenRegenerated = true;
        }
      }

      const updated = await tx.query.bookings.findFirst({
        where: eq(bookings.id, bookingId),
        columns: {
          id: true,
          tourId: true,
          travelerId: true,
          status: true,
          paymentStatus: true,
          totalPrice: true,
          amountPaid: true,
          updatedAt: true,
        },
        with: { magicToken: { columns: { token: true } } },
      });
      if (!updated) throw new NotFoundError("Reserva no encontrada");

      return {
        id: updated.id,
        tourId: updated.tourId,
        travelerId: updated.travelerId,
        status: updated.status,
        paymentStatus: updated.paymentStatus,
        totalPrice: Number(updated.totalPrice),
        amountPaid: Number(updated.amountPaid),
        updatedAt: updated.updatedAt,
        magicToken: updated.magicToken?.token ?? null,
        tokenRegenerated,
        transferredPassenger: {
          previousTravelerId: slot.travelerId,
          newTravelerId: targetTravelerId,
          role: data.role,
        },
      };
    });
  }
}
