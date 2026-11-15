import { and, eq, isNull, ne } from "drizzle-orm";
import type { DbExecutor, DbTransaction } from "../../db/index.js";
import { bookings, tours } from "../../db/schema.js";
import { CapacityExceededError, NotFoundError } from "../../shared/errors/domain-errors.js";
import {
  getExpectedGroupSize,
  getRequiredDeposit,
  getSellableCapacity,
  isDepositCovered,
  sumOccupiedSeats,
} from "../../shared/utils/booking-rules.util.js";

export interface TourCapacity {
  id: string;
  price: number;
  maxCapacity: number;
  staffCapacity: number;
}

export interface TourAvailability {
  sellableCapacity: number;
  occupiedSeats: number;
  availableSeats: number;
}

/**
 * Única implementación del cupo de un tour (regla 12 de CLAUDE.md).
 * Ocupados = tamaño de grupo de TODAS las reservas no canceladas ni borradas,
 * sin importar pago ni formulario. Vendible = maxCapacity − staffCapacity.
 */
export class BookingCapacityService {
  static async getOccupiedSeats(
    executor: DbExecutor,
    tourId: string,
    tourPrice: number,
  ): Promise<number> {
    const activeBookings = await executor.query.bookings.findMany({
      where: and(
        eq(bookings.tourId, tourId),
        ne(bookings.status, "CANCELLED"),
        isNull(bookings.deletedAt),
      ),
      columns: { totalPrice: true },
      with: { magicToken: { columns: { numberPassengers: true } } },
    });

    return sumOccupiedSeats(
      activeBookings.map((booking) => ({
        totalPrice: Number(booking.totalPrice),
        numberPassengers: booking.magicToken?.numberPassengers,
      })),
      Number(tourPrice),
    );
  }

  /**
   * Lugares que ya tienen derecho a asiento: suma del tamaño de grupo de las reservas no
   * canceladas ni borradas que cubren el anticipo requerido (regla 8). Es el mismo criterio que
   * `logistics.total` del Centro de Control. Se usa para validar que un vehículo nuevo alcance.
   */
  static async getSeatRightSeats(
    executor: DbExecutor,
    tour: { id: string; price: number; depositPerPerson: number },
  ): Promise<number> {
    const activeBookings = await executor.query.bookings.findMany({
      where: and(
        eq(bookings.tourId, tour.id),
        ne(bookings.status, "CANCELLED"),
        isNull(bookings.deletedAt),
      ),
      columns: { totalPrice: true, amountPaid: true },
      with: { magicToken: { columns: { numberPassengers: true } } },
    });

    return activeBookings.reduce((total, booking) => {
      const groupSize = getExpectedGroupSize(
        booking.magicToken?.numberPassengers,
        Number(booking.totalPrice),
        Number(tour.price),
      );
      const requiredDeposit = getRequiredDeposit(Number(tour.depositPerPerson), groupSize);
      return isDepositCovered(Number(booking.amountPaid), requiredDeposit)
        ? total + groupSize
        : total;
    }, 0);
  }

  static async getAvailability(
    executor: DbExecutor,
    tour: TourCapacity,
  ): Promise<TourAvailability> {
    const sellableCapacity = getSellableCapacity(tour.maxCapacity, tour.staffCapacity);
    const occupiedSeats = await BookingCapacityService.getOccupiedSeats(
      executor,
      tour.id,
      tour.price,
    );
    return {
      sellableCapacity,
      occupiedSeats,
      availableSeats: Math.max(0, sellableCapacity - occupiedSeats),
    };
  }

  /**
   * Verificación ATÓMICA de cupo. Debe llamarse dentro de la transacción que va a insertar los
   * lugares: bloquea la fila del tour (SELECT … FOR UPDATE), de modo que dos apartados
   * simultáneos del mismo tour se ejecutan uno tras otro y el segundo ve los lugares del primero.
   * Lanza CapacityExceededError (→ 409) sin escribir nada si no alcanza.
   */
  static async assertSeatsAvailable(
    tx: DbTransaction,
    tourId: string,
    requestedSeats: number,
  ): Promise<TourAvailability> {
    const [lockedTour] = await tx
      .select({
        id: tours.id,
        price: tours.price,
        maxCapacity: tours.maxCapacity,
        staffCapacity: tours.staffCapacity,
      })
      .from(tours)
      .where(eq(tours.id, tourId))
      .for("update");

    if (!lockedTour) throw new NotFoundError("Tour no encontrado");

    const availability = await BookingCapacityService.getAvailability(tx, lockedTour);
    if (requestedSeats > availability.availableSeats) {
      throw new CapacityExceededError(availability.availableSeats);
    }
    return availability;
  }
}
