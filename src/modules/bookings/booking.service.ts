import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { CreateBookingBody, CreateReservationBookingBody } from "./booking.schema.js";
import { bookingPassengers, bookings, magicTokens, PAYMENT_STATUS, tours, travelers } from "../../db/schema.js";
import nodeCrypto from "node:crypto";

const generateSecureToken = (length = 32): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

export class BookingService {
    static async processGroupBooking(data: CreateBookingBody, agencyId: string) {
        const { token, ...payload } = data;

        return await db.transaction(async (tx) => {
            // 1. Validar el Token de Seguridad
            const magicToken = await tx.query.magicTokens.findFirst({
                where: eq(magicTokens.token, token)
            });

            if (!magicToken) throw new Error("Token inválido o no encontrado");
            if (new Date() > new Date(magicToken.expiresAt)) throw new Error("El enlace ha expirado");

            // Calculamos cuántos acompañantes vienen en el payload vs cupos del token
            const incomingCompanionsCount = payload.hasCompanions ? payload.companions.length : 0;
            if (magicToken.currentUses + incomingCompanionsCount > magicToken.maxUses) {
                throw new Error("El enlace no tiene suficientes cupos válidos para esta cantidad de acompañantes");
            }

            // 2. Encontrar el Tour
            const tour = await tx.query.tours.findFirst({
                where: eq(tours.id, magicToken.tourId)
            });
            if (!tour) throw new Error("Tour no encontrado");

            // 3. Enriquecer al Titular (Find-or-Update por WhatsApp, NUNCA confiar en payload.id)
            let mainTravelerId: string;
            const existingTitular = await tx.query.travelers.findFirst({
                where: and(
                    eq(travelers.agencyId, agencyId),
                    eq(travelers.whatsappPhone, payload.mainClient.whatsappPhone)
                )
            });

            if (existingTitular) {
                // Actualizamos los datos faltantes (ej. contacto de emergencia)
                await tx.update(travelers).set({
                    fullName: payload.mainClient.fullName,
                    email: payload.mainClient.email,
                    emergencyContactName: payload.mainClient.emergencyContactName,
                    emergencyContactPhone: payload.mainClient.emergencyContactPhone,
                    medicalNotes: payload.mainClient.medicalNotes,
                    updatedAt: new Date().toISOString()
                }).where(eq(travelers.id, existingTitular.id));

                if (payload.mainClient.email && existingTitular.email !== payload.mainClient.email) {
                    await tx.update(travelers)
                        .set({ email: payload.mainClient.email, updatedAt: new Date().toISOString() })
                        .where(eq(travelers.id, existingTitular.id));
                }

                mainTravelerId = existingTitular.id;
            } else {
                // Caso extremo (no debería pasar si el operador lo creó, pero es buena guarda)
                const [newMain] = await tx.insert(travelers).values({
                    agencyId,
                    ...payload.mainClient
                }).returning({ id: travelers.id });

                if (!newMain) throw new Error("No se pudo crear el viajero con sus datos");
                mainTravelerId = newMain.id;
            }

            // 4. Recuperar la Reserva Financiera (creada por el operador)
            const existingBooking = await tx.query.bookings.findFirst({
                where: and(
                    eq(bookings.tourId, tour.id),
                    eq(bookings.travelerId, mainTravelerId),
                    ne(bookings.status, "CANCELLED")
                )
            });

            if (!existingBooking) {
                throw new Error("Fallo de integridad: No se encontró la reserva maestra ligada a este titular.");
            }

            await tx.update(bookingPassengers)
                .set({ boardingPoint: payload.mainClient.boardingPoint })
                .where(
                    and(
                        eq(bookingPassengers.bookingId, existingBooking.id),
                        eq(bookingPassengers.travelerId, mainTravelerId)
                    )
                );

            // 5. Procesar Acompañantes y meterlos al Manifiesto (bookingPassengers)
            const companionTravelerIds: string[] = [];
            const companionTypeMap = new Map<string, "ADULT" | "CHILD">();
            const companionBoardingMap = new Map<string, string>();
            if (payload.hasCompanions && payload.companionMethod === "MANUAL" && payload.companions.length > 0) {
                for (const comp of payload.companions) {
                    // Si el FrontEnd manda ID o si buscamos por WhatsApp
                    let compId: string;

                    const existingComp = comp.whatsappPhone ? await tx.query.travelers.findFirst({
                        where: and(
                            eq(travelers.agencyId, agencyId),
                            eq(travelers.whatsappPhone, comp.whatsappPhone)
                        )
                    }) : null;

                    if (existingComp) {
                        await tx.update(travelers).set({
                            fullName: comp.fullName,
                            email: comp.email || "N/A",
                            emergencyContactName: comp.emergencyContactName,
                            emergencyContactPhone: comp.emergencyContactPhone,
                            medicalNotes: comp.medicalNotes,
                            updatedAt: new Date().toISOString()
                        }).where(eq(travelers.id, existingComp.id));
                        compId = existingComp.id;
                    } else {
                        const [newComp] = await tx.insert(travelers).values({
                            agencyId,
                            fullName: comp.fullName,
                            whatsappPhone: comp.whatsappPhone || null, // Nulo para niños sin cel
                            email: comp.email || null,
                            emergencyContactName: comp.emergencyContactName,
                            emergencyContactPhone: comp.emergencyContactPhone,
                            medicalNotes: comp.medicalNotes,
                        }).returning({ id: travelers.id });

                        if (!newComp) {
                            throw new Error("Fallo al guardar el registro de los acompañantes");
                        }
                        compId = newComp.id;
                    }
                    companionTravelerIds.push(compId);
                    companionTypeMap.set(compId, comp.passengerType);
                    companionBoardingMap.set(compId, comp.boardingPoint);
                }
            }

            // 6. Validar quiénes NO están aún en el Manifiesto de esta reserva
            const existingPassengers = await tx.query.bookingPassengers.findMany({
                where: eq(bookingPassengers.bookingId, existingBooking.id)
            });
            const passengerIdsInBus = existingPassengers.map(p => p.travelerId);
            const newPassengersToInsert = companionTravelerIds.filter(id => !passengerIdsInBus.includes(id));

            if (newPassengersToInsert.length > 0) {
                //  Validar que los nuevos acompañantes no estén en OTRA reserva del mismo tour
                const existingCompanionsInTour = await tx.query.bookingPassengers.findFirst({
                    where: and(
                        inArray(bookingPassengers.travelerId, newPassengersToInsert),
                        inArray(
                            bookingPassengers.bookingId,
                            db.select({ id: bookings.id })
                                .from(bookings)
                                .where(and(eq(bookings.tourId, tour.id), ne(bookings.status, "CANCELLED")))
                        )
                    )
                });

                if (existingCompanionsInTour) {
                    throw new Error("Uno de los acompañantes ingresados ya cuenta con un lugar asegurado en este tour bajo otra reserva.");
                }

                // Insertamos a los acompañantes apuntando al ÚNICO recibo (bookingId)
                const passengersData = newPassengersToInsert.map(travelerId => ({
                    bookingId: existingBooking.id,
                    travelerId: travelerId,
                    isTitular: false,
                    passengerType: companionTypeMap.get(travelerId) || "ADULT",
                    boardingPoint: companionBoardingMap.get(travelerId) || null,
                }));
                await tx.insert(bookingPassengers).values(passengersData);
            }

            // 7. Quemar los usos del Token
            if (incomingCompanionsCount > 0) {
                await tx.update(magicTokens).set({
                    currentUses: magicToken.currentUses + incomingCompanionsCount
                }).where(eq(magicTokens.id, magicToken.id));
            }

            return {
                bookingId: existingBooking.id,
                acceptsBankTransfer: tour.acceptsBankTransfer,
                bankDetails: tour.bankDetails,
                acceptsCreditCard: tour.acceptsCreditCard,
                paymentLink: tour.paymentLink,
                acceptsCash: tour.acceptsCash,
                cashInstructions: tour.cashInstructions,
                totalPassengersRegistered: passengerIdsInBus.length + newPassengersToInsert.length,
                message: "Registro completado con éxito."
            };
        });
    }

    static async createQuickBooking(tourId: string, data: CreateReservationBookingBody, agencyId: string) {
        const { numberPassengers, fullName, whatsapp, email } = data;

        return await db.transaction(async (tx) => {
            // 1. Validar existencia del Tour
            const tour = await tx.query.tours.findFirst({
                where: eq(tours.id, tourId)
            });

            if (!tour) throw new Error("Tour no encontrado");

            // 2. Control de Asientos Crítico (Capacidad)
            const [reservations] = await tx
                .select({ totalAsientos: count() })
                .from(bookings)
                .where(
                    and(
                        eq(bookings.tourId, tourId),
                        ne(bookings.status, "CANCELLED")
                    )
                );

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
                    isNull(travelers.deletedAt)
                )
            });

            if (existingTitular) {
                titularId = existingTitular.id;
            } else {
                const [newTitular] = await tx.insert(travelers).values({
                    agencyId,
                    fullName,
                    whatsappPhone: whatsapp,
                    email,
                    emergencyContactName: "",
                    emergencyContactPhone: "",
                }).returning({ id: travelers.id });

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
                        db.select({ id: bookings.id })
                            .from(bookings)
                            .where(and(eq(bookings.tourId, tourId), ne(bookings.status, "CANCELLED")))
                    )
                )
            });

            if (existingPassengerInTour) {
                throw new Error("El viajero ya cuenta con una reserva activa o forma parte de un grupo en este tour.");
            }

            // 5. Crear la Reserva (Booking PENDING)
            const groupReference = `GRP-${generateSecureToken(8).toUpperCase()}`;

            const [newBooking] = await tx.insert(bookings).values({
                agencyId,
                tourId,
                travelerId: titularId,
                groupReference,
                totalPrice: Number(tour.price) * numberPassengers,
                amountPaid: 0,
                status: "PENDING",
                paymentStatus: "PENDING"
            }).returning({ id: bookings.id });

            if (!newBooking) {
                throw new Error("Fallo crítico: No se pudo generar la reserva en la base de datos.");
            }

            // 6. Vincular al Titular al Manifiesto
            await tx.insert(bookingPassengers).values({
                bookingId: newBooking.id,
                travelerId: titularId,
                isTitular: true
            });

            // 7. Generar el Magic Link Token
            const rawToken = nodeCrypto.randomUUID().replace(/-/g, '');
            const expires = new Date();
            expires.setHours(expires.getHours() + 48);

            await tx.insert(magicTokens).values({
                agencyId,
                tourId,
                bookingId: newBooking.id,
                token: rawToken,
                maxUses: numberPassengers,
                currentUses: 1,
                expiresAt: expires.toISOString()
            });

            return {
                bookingId: newBooking.id,
                token: rawToken,
                availableSeats: availableSeats - numberPassengers
            };
        });
    }

    static async cancelBooking(
        bookingId: string,
        penaltyPercentage: number,
        agencyId: string

    ) {
        // PATRÓN: Transacción ACID. Si algo falla a la mitad (ej. el servidor se apaga),
        // PostgreSQL revierte todo. No hay reservas "a medio cancelar".
        return db.transaction(async (tx) => {

            // 1. PATRÓN FAIL-FAST (Falla rápido): 
            // Buscamos la reserva y validamos estado antes de hacer cálculos pesados.

            const booking = await tx.query.bookings.findFirst({
                where: and(
                    eq(bookings.id, bookingId),
                    eq(bookings.agencyId, agencyId)
                )
            })

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

            await tx.update(bookingPassengers).
                set({ status: "CANCELLED" }).
                where(eq(bookingPassengers.bookingId, bookingId))

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
            let newPaymentStatus: typeof PAYMENT_STATUS.enumValues[number] = booking.paymentStatus;

            if (amountPaid >= newTotalPrice && newTotalPrice > 0) {
                newPaymentStatus = "PAID";
            } else if (newTotalPrice === 0 && amountPaid === 0) {
                // Si perdonamos toda la deuda y no habían dado ni un peso, el status de pago queda neutral
                newPaymentStatus = "PENDING";
            }

            // 5. ACTUALIZAR LA RAÍZ DEL AGREGADO (La Reserva)
            await tx.update(bookings)
                .set({
                    status: "CANCELLED", // 👈 Liberamos los asientos para revenderlos
                    totalPrice: newTotalPrice,
                    paymentStatus: newPaymentStatus,
                    updatedAt: new Date().toISOString()
                })
                .where(eq(bookings.id, bookingId));

            // 6. PREPARAR EL CONTEXTO PARA EL FRONT-END
            // El Front-End no debería calcular saldos, esa es responsabilidad del Back-End.
            const isOverpaid = amountPaid > newTotalPrice;
            const surplusAmount = isOverpaid ? (amountPaid - newTotalPrice) : 0;

            return {
                message: "Reserva cancelada exitosamente. Los asientos han sido liberados.",
                financialSummary: {
                    previousTotal: currentTotalPrice,
                    newTotal: newTotalPrice,
                    amountPaid: amountPaid,
                    hasSurplus: isOverpaid,
                    surplusAmount: surplusAmount,
                }
            };
        })

    }
}