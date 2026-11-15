import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateBookingStatus,
  getExpectedGroupSize,
  getRequiredDeposit,
  getSellableCapacity,
  isDepositCovered,
  sumOccupiedSeats,
  type BookingStatus,
} from "../src/shared/utils/booking-rules.util.js";

const status = (
  currentStatus: BookingStatus,
  totalPaid: number,
  requiredDeposit: number,
  isFormComplete = currentStatus !== "AWAITING_REGISTRATION",
) => calculateBookingStatus({ currentStatus, totalPaid, requiredDeposit, isFormComplete });

// Decisiones del PM (2026-11-11): derecho a asiento y confirmación con el anticipo cubierto.
describe("Reglas de anticipo y confirmación (booking-rules.util)", () => {
  it("anticipo requerido = anticipo por persona × lugares apartados", () => {
    assert.equal(getRequiredDeposit(500, 3), 1500);
    assert.equal(getRequiredDeposit(0, 3), 0);
  });

  it("tamaño de grupo: lugares del Magic Link; sin token, total / precio", () => {
    assert.equal(getExpectedGroupSize(3, 4500, 1500), 3);
    assert.equal(getExpectedGroupSize(null, 4500, 1500), 3);
    assert.equal(getExpectedGroupSize(undefined, 0, 1500), 1);
  });

  it("un abono de $50 no cubre un anticipo de $500; $500 exactos sí", () => {
    assert.equal(isDepositCovered(50, 500), false);
    assert.equal(isDepositCovered(500, 500), true);
    assert.equal(isDepositCovered(800, 500), true);
  });

  it("anticipo $0 (regla literal): se cubre sin pagos", () => {
    assert.equal(isDepositCovered(0, 0), true);
  });

  it("formulario lleno (PENDING) + anticipo cubierto → CONFIRMED", () => {
    assert.equal(status("PENDING", 1500, 1500), "CONFIRMED");
  });

  it("estado derivado: CONFIRMED vuelve a PENDING si deja de cubrir el anticipo", () => {
    assert.equal(status("CONFIRMED", 1000, 1500), "PENDING");
  });

  it("sin formulario (AWAITING_REGISTRATION) no se confirma aunque esté pagado", () => {
    assert.equal(status("AWAITING_REGISTRATION", 99999, 1500), "AWAITING_REGISTRATION");
  });

  it("formulario recién completado: sale de AWAITING_REGISTRATION según el anticipo", () => {
    assert.equal(status("AWAITING_REGISTRATION", 0, 1500, true), "PENDING");
    assert.equal(status("AWAITING_REGISTRATION", 1500, 1500, true), "CONFIRMED");
  });

  it("anticipo $0: se confirma al completar el formulario, sin pagos", () => {
    assert.equal(status("AWAITING_REGISTRATION", 0, 0, false), "AWAITING_REGISTRATION");
    assert.equal(status("AWAITING_REGISTRATION", 0, 0, true), "CONFIRMED");
  });

  it("CANCELLED y NO_SHOW nunca cambian por pagos", () => {
    assert.equal(status("CANCELLED", 99999, 0), "CANCELLED");
    assert.equal(status("NO_SHOW", 99999, 0), "NO_SHOW");
  });
});

// Decisión del PM: cupo = capacidad vendible; ocupación = todas las reservas no canceladas.
describe("Reglas de cupo (booking-rules.util)", () => {
  it("capacidad vendible = total − staff (nunca negativa)", () => {
    assert.equal(getSellableCapacity(20, 2), 18);
    assert.equal(getSellableCapacity(20, 0), 20);
    assert.equal(getSellableCapacity(5, 9), 0);
  });

  it("ocupados suma personas (lugares apartados), no reservas", () => {
    const rows = [
      { totalPrice: 4000, numberPassengers: 4 },
      { totalPrice: 3000, numberPassengers: null }, // sin token: 3000 / 1000 = 3
      { totalPrice: 1000, numberPassengers: 1 },
    ];
    assert.equal(sumOccupiedSeats(rows, 1000), 8);
    assert.equal(sumOccupiedSeats([], 1000), 0);
  });
});
