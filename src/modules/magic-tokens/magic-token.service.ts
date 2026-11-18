import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { magicTokens } from "../../db/schema.js";
import { findBoardingPoint } from "../../shared/utils/boarding-point.util.js";
import { AgencyBrandingService } from "../agencies/agency-branding.service.js";
import {
  getExpectedGroupSize,
  resolveAgreedUnitPrice,
} from "../../shared/utils/booking-rules.util.js";
import { summarizeRefunds } from "../../shared/utils/refund.util.js";

export class MagicTokenService {
  /**
   * Contexto mínimo para `lookup-traveler`: la agencia del token, solo si la reserva sigue esperando
   * el registro del grupo (`AWAITING_REGISTRATION`). El registro se acepta una sola vez, así que
   * después la búsqueda por teléfono no tiene uso; como el enlace no vence, sin este candado cada
   * Magic Link era un oráculo permanente para enumerar clientes de la agencia. Una consulta ligera
   * (antes se cargaba todo el grafo del Magic Link solo para obtener el `agencyId`).
   */
  static async findRegistrationContext(tokenValue: string): Promise<{ agencyId: string } | null> {
    const magicToken = await db.query.magicTokens.findFirst({
      where: eq(magicTokens.token, tokenValue),
      columns: { agencyId: true },
      with: { booking: { columns: { status: true, deletedAt: true } } },
    });
    if (!magicToken?.booking || magicToken.booking.deletedAt) return null;
    if (magicToken.booking.status !== "AWAITING_REGISTRATION") return null;
    return { agencyId: magicToken.agencyId };
  }

  static async validate(tokenValue: string) {
    // 1. Aseguramos traer la data necesaria desde Drizzle
    const magicToken = await db.query.magicTokens.findFirst({
      where: eq(magicTokens.token, tokenValue),
      with: {
        tour: { with: { agency: { with: { branding: true } } } },
        booking: {
          with: { passengers: { with: { traveler: true } }, payments: true },
        },
      },
    });

    if (!magicToken) return { error: { code: "NOT_FOUND" } };

    const booking = magicToken.booking;
    if (!booking) return { error: { code: "NOT_FOUND" } };
    const tour = magicToken.tour;
    const agency = tour.agency;
    const brandingColors = AgencyBrandingService.resolveColors(agency.branding);

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
          currency: tour.currency,
          // Precio PACTADO por lugar (OBS-040, 2026-11-17): el formulario calcula lugares × este precio.
          // Antes era `tour.price` (precio actual): si la agencia lo cambiaba antes del primer pago,
          // el cliente veía un total distinto al de su reserva.
          priceTotalPerPassenger: resolveAgreedUnitPrice({
            unitPrice: booking.unitPrice,
            totalPrice: booking.totalPrice,
            numberPassengers: magicToken.numberPassengers,
            tourPrice: tour.price,
          }),
          depositPerPassenger: tour.depositPerPerson ? Number(tour.depositPerPerson) : null,
          reservedSeats: magicToken.numberPassengers,
        },
        agencyName: agency.name,
        // Aviso de privacidad de la agencia (enlace junto a la casilla obligatoria del registro).
        agencyPrivacyNoticeUrl: agency.privacyNoticeUrl ?? null,
        // Políticas generales de la agencia (texto plano, regla 17): el modal "Políticas de Viaje y
        // Aviso de Privacidad" las muestra junto a la casilla obligatoria del registro.
        agencyPolicies: agency.policies?.trim() || null,
        prefillData: traveler
          ? {
              fullName: traveler.fullName || "",
              // E.164 (o 10 dígitos de registros anteriores) + país; país nulo = sin confirmar.
              whatsappPhone: traveler.whatsappPhone || "",
              whatsappCountry: traveler.whatsappCountry ?? null,
              email: traveler.email || "",
              emergencyContactName: traveler.emergencyContactName || "",
              emergencyContactPhone: traveler.emergencyContactPhone || "",
              emergencyContactCountry: traveler.emergencyContactCountry ?? null,
              // Las notas médicas (dato sensible, LFPDPPP) no viajan en el enlace público, igual que
              // en lookup-traveler: si el viajero ya las tenía se conservan (solo se completan los
              // campos vacíos al registrar, `fillEmptyTravelerFields`).
              medicalNotes: "",
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
          returnDate: tour.returnDate ?? null,
          currency: tour.currency,
          // Indicaciones de logística del tour (Magic Link y estado de cuenta PDF). Las reglas
          // legales van aparte: agency.policies (políticas generales de la agencia).
          postPaymentInstructions: tour.postPaymentInstructions?.trim() || null,
        },
        // Lugares apartados (tamaño esperado del grupo): el estado de cuenta muestra los pendientes.
        groupSize: getExpectedGroupSize(
          magicToken.numberPassengers,
          Number(booking.totalPrice),
          Number(tour.price),
        ),
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
        passengers: booking.passengers.map((p) => {
          // Punto configurado en el tour (ubicación y hora), resuelto con la misma regla del manifiesto.
          const point = findBoardingPoint(p.boardingPoint, tour.boardingPoints ?? []);
          return {
            name: p.traveler.fullName,
            type: p.isTitular ? "Titular" : "Acompañante",
            boardingPoint: p.boardingPoint,
            // Campos para el pase de abordaje digital (vista PAID).
            isTitular: p.isTitular,
            status: p.status,
            seatLabel: p.seatLabel ?? null,
            // Teléfono de contacto del pasajero (columna del estado de cuenta PDF).
            phone: p.traveler.whatsappPhone ?? null,
            boardingPointDetails: point ? { location: point.location, time: point.time } : null,
          };
        }),
        agency: {
          name: agency.name,
          phone: agency.phone,
          email: agency.email,
          address: agency.address ?? null,
          bankName: agency.bankName,
          accountHolder: agency.bankAccountHolder,
          clabeNumber: agency.clabeNumber,
          cardNumber: agency.cardNumber ?? null,
          policies: agency.policies ?? null,
          // Identidad visual para el comprobante PDF (logo físico + colores de agency_branding).
          logoPath: agency.logoPath ?? null,
          primaryColor: brandingColors.primaryColor,
          secondaryColor: brandingColors.secondaryColor,
          accentColor: brandingColors.accentColor,
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
          // Tarjeta para depósito/transferencia (se muestra junto a la CLABE en "Métodos y opciones de pago").
          cardNumber: agency.cardNumber ?? null,
          acceptsCreditCard: tour.acceptsCreditCard,
          paymentLink: tour.paymentLink,
          acceptsCash: tour.acceptsCash,
          cashInstructions: tour.cashInstructions,
        },
        tourInfo: {
          title: tour.title,
          departureDateTime: tour.departureDateTime,
          currency: tour.currency,
        },
        titularName: titular?.fullName || "Viajero",
      };
    } else if (flowState === "CANCELLED") {
      // Reserva cancelada (decisión del PM, 2026-11-14). Si la canceló la agencia (tour cancelado),
      // el viajero ve el motivo y el estado de su devolución. La nota interna no se envía.
      // Solo montos agregados: sin abonos individuales ni datos bancarios.
      // Solo hay devolución cuando cancela la agencia (decisión del PM, 2026-11-14). Si canceló el
      // cliente, no se envían montos: la penalización se aplicó según las políticas.
      const refund = tour.cancelledAt
        ? summarizeRefunds({
            amountPaid: booking.amountPaid,
            totalPrice: booking.totalPrice,
            payments: booking.payments,
          })
        : null;
      payloadData = {
        tourInfo: {
          title: tour.title,
          departureDateTime: tour.departureDateTime,
          currency: tour.currency,
        },
        cancellation: tour.cancelledAt
          ? { byAgency: true, reason: tour.cancellationReason, cancelledAt: tour.cancelledAt }
          : { byAgency: false, reason: null, cancelledAt: null },
        refund,
      };
    }

    return {
      isValid: true,
      flowState,
      meta: {
        agencyId: agency.id,
        // Marca de la agencia, igual en todos los estados (incluido CANCELLED): el front la
        // muestra en el encabezado de cada vista del Magic Link. Solo datos públicos.
        // `phone` es el WhatsApp público de la agencia (el folleto también lo muestra): el pie de
        // todas las vistas ofrece "Contactar asesor por WhatsApp".
        agency: {
          name: agency.name,
          logoPath: agency.logoPath ?? null,
          phone: agency.phone ?? null,
        },
        tourId: tour.id,
        bookingId: booking.id,
      },
      data: payloadData,
    };
  }
}
