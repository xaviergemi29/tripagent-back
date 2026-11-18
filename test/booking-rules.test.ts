import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateBookingStatus,
  getExpectedGroupSize,
  getRefundableSurplus,
  getRetainedPenaltyTotal,
  getRequiredDeposit,
  getSellableCapacity,
  isDepositCovered,
  sumOccupiedSeats,
  summarizeCompanionDrop,
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

// Baja de un acompañante con retención para la agencia (FLUJO-RES-004 / PQ-C5, 2026-11-17).
describe("summarizeCompanionDrop (finanzas de la baja de un acompañante)", () => {
  const cases: [string, Parameters<typeof summarizeCompanionDrop>[0], Record<string, number>][] = [
    [
      "Escenario 1: retención parcial con saldo pendiente",
      { currentTotal: 3000, unitPrice: 1000, penaltyAmount: 250, amountPaid: 1500 },
      { newTotal: 2250, nonRetainedAmount: 750, pendingBalance: 750, refundableSurplus: 0 },
    ],
    [
      "Escenario 2: retención del 100 % del lugar",
      { currentTotal: 6000, unitPrice: 2000, penaltyAmount: 2000, amountPaid: 6000 },
      { newTotal: 6000, nonRetainedAmount: 0, pendingBalance: 0, refundableSurplus: 0 },
    ],
    [
      "Escenario 3: sin retención",
      { currentTotal: 3000, unitPrice: 1000, penaltyAmount: 0, amountPaid: 1000 },
      { newTotal: 2000, nonRetainedAmount: 1000, pendingBalance: 1000, refundableSurplus: 0 },
    ],
    [
      "Escenario 4: liquidada → saldo a devolver",
      { currentTotal: 3000, unitPrice: 1000, penaltyAmount: 250, amountPaid: 3000 },
      { newTotal: 2250, nonRetainedAmount: 750, pendingBalance: 0, refundableSurplus: 750 },
    ],
    [
      "el nuevo total nunca es negativo",
      { currentTotal: 500, unitPrice: 1000, penaltyAmount: 0, amountPaid: 0 },
      { newTotal: 0, pendingBalance: 0, refundableSurplus: 0 },
    ],
  ];
  for (const [label, input, expected] of cases) {
    it(label, () => {
      const summary = summarizeCompanionDrop(input);
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(summary[key as keyof typeof summary], value, key);
      }
      assert.equal(summary.amountPaid, input.amountPaid); // lo abonado no cambia
    });
  }

  it("retenciones acumuladas: lo que el total excede al precio pactado × lugares apartados", () => {
    assert.equal(getRetainedPenaltyTotal({ totalPrice: 2250, unitPrice: 1000, groupSize: 2 }), 250);
    assert.equal(getRetainedPenaltyTotal({ totalPrice: 3000, unitPrice: 1000, groupSize: 3 }), 0);
    // Un lugar sin registrar no es retención: se cobra a precio pactado.
    assert.equal(getRetainedPenaltyTotal({ totalPrice: 2000, unitPrice: 1000, groupSize: 2 }), 0);
  });

  it("saldo a devolver: lo abonado que excede al total", () => {
    assert.equal(getRefundableSurplus({ amountPaid: 3000, totalPrice: 2250 }), 750);
    assert.equal(getRefundableSurplus({ amountPaid: 1500, totalPrice: 2250 }), 0);
  });
});
