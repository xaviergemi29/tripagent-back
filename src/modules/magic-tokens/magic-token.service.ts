import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { magicTokens } from "../../db/schema.js";

export class MagicTokenService {
  static async validate(tokenValue: string) {
    // 1. Aseguramos traer la data necesaria desde Drizzle
    const magicToken = await db.query.magicTokens.findFirst({
      where: eq(magicTokens.token, tokenValue),
      with: {
        tour: { with: { agency: true } },
        booking: {
          with: { passengers: { with: { traveler: true } }, payments: true },
        },
      },
    });

    console.log("magicToken", magicToken);
    if (!magicToken) return { error: { code: "NOT_FOUND" } };

    const booking = magicToken.booking;
    if (!booking) throw new Error("Error al buscar la resrva asociada al token");
    const tour = magicToken.tour;
    const agency = tour.agency;

    // 2. Máquina de Estados (Derivación jerárquica)
    let flowState = "";

    // Prioridad 1: Estados terminales o destructivos
    if (booking.status === "CANCELLED") {
      flowState = "CANCELLED";
    }
    // Prioridad 2: Captura de datos (Bloqueante logístico)
    else if (booking.status === "AWAITING_REGISTRATION") {
      flowState = "PENDING_REGISTRATION";
    }
    // Prioridad 3: Estados financieros (El usuario ya registró datos)
    else {
      // Manejamos PENDING_PAYMENT, PARTIAL_PAYMENT y PAID basándonos puramente
      // en el estatus financiero, ignorando si logística es PENDING o CONFIRMED.
      if (booking.paymentStatus === "PENDING") {
        flowState = "PENDING_PAYMENT";
      } else if (booking.paymentStatus === "PARTIAL") {
        flowState = "PARTIAL_PAYMENT";
      } else if (booking.paymentStatus === "PAID") {
        flowState = "PAID";
      }
    }

    // Defensa contra inconsistencias no contempladas
    if (!flowState) {
      return { error: { code: "INVALID_STATE", message: "Estado de reserva no soportado." } };
    }

    // 3. POLIMORFISMO DE PAYLOADS (El corazón del BFF)
    let payloadData = {};

    if (flowState === "PENDING_REGISTRATION") {
      const titularPassenger = booking.passengers.find((p) => p.isTitular);
      const traveler = titularPassenger?.traveler;

      // Props exactas para <TourRegistrationView />
      payloadData = {
        boardingPoints: tour.boardingPoints,
        tourInfo: {
          title: tour.title,
          departureDateTime: tour.departureDateTime,
          priceTotalPerPassenger: Number(tour.price),
          depositPerPassenger: tour.depositPerPerson ? Number(tour.depositPerPerson) : null,
          reservedSeats: magicToken.numberPassengers,
        },
        agencyName: agency.name,
        prefillData: traveler
          ? {
              fullName: traveler.fullName || "",
              whatsappPhone: traveler.whatsappPhone || "",
              email: traveler.email || "",
              emergencyContactName: traveler.emergencyContactName || "",
              emergencyContactPhone: traveler.emergencyContactPhone || "",
              medicalNotes: traveler.medicalNotes || "",
              birthDate: traveler.birthDate || "",
              // Si el pasajero ya tenía un punto de abordaje asignado en la BD
              boardingPoint: titularPassenger?.boardingPoint || "",
            }
          : null,
      };
    } else if (flowState === "PARTIAL_PAYMENT" || flowState === "PAID") {
      payloadData = {
        bookingId: booking.id,
        tourInfo: {
          title: tour.title,
          departureDateTime: tour.departureDateTime,
        },
        // CONFIRMED solo cuando el anticipo está cubierto y el formulario lleno (regla del PM).
        bookingStatus: booking.status,
        financials: {
          totalAmount: Number(booking.totalPrice),
          amountPaid: Number(booking.amountPaid),
          remainingBalance: Number(booking.totalPrice) - Number(booking.amountPaid),
          status: booking.paymentStatus, // PENDING, PARTIAL, PAID
        },
        // Mapeamos los pagos para renderizar una tabla o timeline
        // Decisión del PM: el cliente solo ve abonos válidos. Se excluyen los movimientos de
        // anulación (REFUND) y también el abono original anulado, que voidPayment liga con
        // "(Ref: <id del abono>)" en referenceInfo.
        paymentHistory: booking.payments
          .filter(
            (p) =>
              p.type === "PAYMENT" &&
              Number(p.amount) > 0 &&
              !booking.payments.some(
                (r) => r.type === "REFUND" && r.referenceInfo?.includes(`(Ref: ${p.id})`),
              ),
          )
          .map((p) => ({
            id: p.id,
            date: p.createdAt,
            amount: Number(p.amount),
            method: p.method,
            reference: p.referenceInfo,
          })),
        passengers: booking.passengers.map((p) => ({
          name: p.traveler.fullName,
          type: p.isTitular ? "Titular" : "Acompañante",
          boardingPoint: p.boardingPoint,
        })),
        agency: {
          name: agency.name,
          phone: agency.phone,
          bankName: agency.bankName,
          accountHolder: agency.bankAccountHolder,
          clabeNumber: agency.clabeNumber,
        },
      };
    } else if (flowState === "PENDING_PAYMENT" || flowState === "PARTIAL_PAYMENT") {
      // 🎯 Props exactas para <BookingSuccessView />
      const titular = booking.passengers.find((p) => p.isTitular)?.traveler;
      const companions = booking.passengers
        .filter((p) => !p.isTitular)
        .map((p) => p.traveler.fullName);

      payloadData = {
        booking: {
          bookingId: booking.id,
          agencyName: agency.name,
          agencyPhone: agency.phone,
          titularName: titular?.fullName,
          companionNames: companions,
          passengers: booking.passengers.map((p) => ({
            name: p.traveler.fullName,
            isTitular: p.isTitular,
            boardingPoint: p.boardingPoint,
          })),
          totalAmount: Number(booking.totalPrice),
          depositAmount: tour.depositPerPerson
            ? Number(tour.depositPerPerson) * booking.passengers.length
            : null,
          acceptsBankTransfer: tour.acceptsBankTransfer,
          bankName: agency.bankName,
          accountHolder: agency.bankAccountHolder,
          clabeNumber: agency.clabeNumber,
          acceptsCreditCard: tour.acceptsCreditCard,
          paymentLink: tour.paymentLink,
          acceptsCash: tour.acceptsCash,
          cashInstructions: tour.cashInstructions,
        },
        tourInfo: { title: tour.title, departureDateTime: tour.departureDateTime },
        titularName: titular?.fullName || "Viajero",
      };
    }

    return {
      isValid: true,
      flowState,
      meta: {
        agencyId: agency.id,
        tourId: tour.id,
        bookingId: booking.id,
      },
      data: payloadData,
    };
  }
}
