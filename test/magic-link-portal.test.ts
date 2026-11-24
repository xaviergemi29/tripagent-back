import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/index.js";
import { AGENCY_A, createTestApp, type TestApp } from "./helpers.js";

const P1 = "a1a1a1a1-0000-4000-8000-000000000001";
const P2 = "a1a1a1a1-0000-4000-8000-000000000002"; // abono anulado
const P3 = "a1a1a1a1-0000-4000-8000-000000000003";

/** Magic Link de Ana Torres: total $6,000; abonos $2,000 + $1,500 (anulado) + $2,500 = $4,500. */
function magicTokenWith(status: string, paymentStatus: string, amountPaid: number) {
  return {
    token: "tok",
    numberPassengers: 4,
    tour: {
      id: "tour-1",
      title: "Cascadas de Cuetzalan",
      departureDateTime: "2026-12-20",
      price: 1500,
      depositPerPerson: 500,
      boardingPoints: [],
      agency: {
        id: AGENCY_A,
        name: "Viajes Xalapa",
        phone: "2281234567",
        bankAccounts: [
          {
            bankName: "Banco",
            accountHolder: "Titular",
            clabeNumber: "012345678901234567",
            cardNumber: null as string | null,
          },
        ],
      },
    },
    booking: {
      id: "booking-1",
      status,
      paymentStatus,
      totalPrice: 6000,
      amountPaid,
      passengers: [
        {
          isTitular: true,
          status: "ACTIVE",
          boardingPoint: "Plaza (06:00)",
          traveler: { fullName: "Ana Torres" },
        },
      ],
      payments: [
        {
          id: P1,
          type: "PAYMENT",
          amount: 2000,
          method: "TRANSFER",
          createdAt: "2026-11-01",
          referenceInfo: null,
        },
        {
          id: P2,
          type: "PAYMENT",
          amount: 1500,
          method: "CASH",
          createdAt: "2026-11-02",
          referenceInfo: null,
        },
        {
          id: P3,
          type: "PAYMENT",
          amount: 2500,
          method: "CARD",
          createdAt: "2026-11-03",
          referenceInfo: null,
        },
        {
          id: "refund-1",
          type: "REFUND",
          amount: -1500,
          method: "CASH",
          createdAt: "2026-11-04",
          referenceInfo: `Anulación: Error de captura (Ref: ${P2})`,
        },
      ],
    },
  };
}

describe("Magic Link (portal del viajero): decisiones del PM", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("solo muestra abonos válidos: oculta la anulación y el abono anulado; la lista cuadra con el total", async () => {
    mock.method(db.query.magicTokens, "findFirst", (async () =>
      magicTokenWith("CONFIRMED", "PARTIAL", 4500)) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    const { data } = res.json();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      data.paymentHistory.map((p: { id: string }) => p.id),
      [P1, P3],
    );
    const listed = data.paymentHistory.reduce(
      (sum: number, p: { amount: number }) => sum + p.amount,
      0,
    );
    assert.equal(listed, data.financials.amountPaid); // $4,500 = $4,500
  });

  it("pide los pagos en orden cronológico (la pantalla numera los abonos como el PDF)", async () => {
    const calls: unknown[] = [];
    mock.method(db.query.magicTokens, "findFirst", (async (config: unknown) => {
      calls.push(config);
      return magicTokenWith("CONFIRMED", "PARTIAL", 4500);
    }) as never);

    await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });

    const config = calls[0] as {
      with: { booking: { with: { payments: { orderBy: (t: unknown, o: unknown) => unknown } } } };
    };
    const orderBy = config.with.booking.with.payments.orderBy(
      { createdAt: "createdAt", id: "id" },
      { asc: (column: string) => `asc:${column}` },
    );
    assert.deepEqual(orderBy, ["asc:createdAt", "asc:id"]);
  });

  it("expone bookingStatus para el distintivo de confirmación", async () => {
    mock.method(db.query.magicTokens, "findFirst", (async () =>
      magicTokenWith("PENDING", "PARTIAL", 50)) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });

    assert.equal(res.json().data.bookingStatus, "PENDING");
  });

  it("una falla interna responde 500 SERVER_ERROR, no NOT_FOUND (el enlace sí existe)", async () => {
    mock.method(db.query.magicTokens, "findFirst", (async () => {
      throw new Error("connection terminated");
    }) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), {
      isValid: false,
      error: { code: "SERVER_ERROR", message: "Error interno del servidor" },
    });
    assert.doesNotMatch(res.body, /connection terminated/);
  });

  it("el enlace no vence: no existe validación de expiración", async () => {
    const token = magicTokenWith("CONFIRMED", "PAID", 6000);
    mock.method(db.query.magicTokens, "findFirst", (async () => ({
      ...token,
      expiresAt: "2020-01-01T00:00:00Z", // fecha guardada en el pasado
    })) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().flowState, "PAID");
  });
  it("pase de abordaje (PAID): expone asiento, punto con hora, estado del pasajero, moneda y dirección", async () => {
    const token = magicTokenWith("CONFIRMED", "PAID", 6000);
    token.tour.boardingPoints = [
      { id: "bp-1", location: "Plaza", time: "06:00" },
      { id: "bp-2", location: "Oxxo Tec", time: "05:30" },
    ] as never;
    Object.assign(token.tour, { currency: "MXN" });
    Object.assign(token.tour.agency, { address: "Xalapa, Veracruz" });
    token.booking.passengers = [
      {
        isTitular: true,
        status: "ACTIVE",
        seatLabel: "4",
        boardingPoint: "Plaza (06:00)",
        traveler: { fullName: "Ana Torres" },
      },
      {
        isTitular: false,
        status: "ACTIVE",
        seatLabel: null,
        boardingPoint: "bp-2",
        traveler: { fullName: "Luis Torres" },
      },
      {
        isTitular: false,
        status: "CANCELLED",
        seatLabel: null,
        boardingPoint: "Desconocido",
        traveler: { fullName: "Eva Torres" },
      },
    ] as never;
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    const { flowState, data } = res.json();

    assert.equal(flowState, "PAID");
    assert.equal(data.tourInfo.currency, "MXN");
    assert.equal(data.agency.address, "Xalapa, Veracruz");
    assert.deepEqual(
      data.passengers.map((p: { isTitular: boolean; status: string; seatLabel: string | null }) => [
        p.isTitular,
        p.status,
        p.seatLabel,
      ]),
      // El acompañante dado de baja (Eva) no aparece en el pase de abordaje.
      [
        [true, "ACTIVE", "4"],
        [false, "ACTIVE", null],
      ],
    );
    assert.deepEqual(data.passengers[0].boardingPointDetails, { location: "Plaza", time: "06:00" });
    assert.deepEqual(data.passengers[1].boardingPointDetails, {
      location: "Oxxo Tec",
      time: "05:30",
    });
    assert.ok(!res.body.includes("Eva Torres"));
  });

  it("aviso de menores: hasMinors e isMinor por pasajero (Niño o menor de 18), sin enviar la fecha", async () => {
    const token = magicTokenWith("CONFIRMED", "PAID", 6000);
    const thisYear = new Date().getFullYear();
    token.booking.passengers = [
      {
        isTitular: true,
        status: "ACTIVE",
        passengerType: "ADULT",
        boardingPoint: "Plaza (06:00)",
        traveler: { fullName: "Ana Torres", birthDate: "1985-04-02" },
      },
      {
        isTitular: false,
        status: "ACTIVE",
        passengerType: "ADULT",
        boardingPoint: "Plaza (06:00)",
        // Marcado como Adulto pero con 16 años: también cuenta como menor.
        traveler: { fullName: "Leo Torres", birthDate: `${thisYear - 16}-01-10` },
      },
      {
        isTitular: false,
        status: "ACTIVE",
        passengerType: "CHILD",
        boardingPoint: "Plaza (06:00)",
        traveler: { fullName: "Mía Torres", birthDate: null },
      },
    ] as never;
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    const { data } = res.json();

    assert.equal(data.hasMinors, true);
    assert.deepEqual(
      data.passengers.map((p: { isMinor: boolean }) => p.isMinor),
      [false, true, true],
    );
    assert.ok(!res.body.includes("1985-04-02"));
  });

  it("comprobante PDF: la agencia trae logo, colores de marca, correo y cuentas con tarjeta", async () => {
    const token = magicTokenWith("CONFIRMED", "PARTIAL", 4500);
    token.tour.agency.bankAccounts[0]!.cardNumber = "4152313412345678";
    Object.assign(token.tour.agency, {
      email: "hola@viajesxalapa.mx",
      logoPath: "/uploads/logos/agency-a-1.png",
      branding: { primaryColor: "#059669", secondaryColor: "#047857", accentColor: null },
    });
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    const { agency } = res.json().data;

    assert.equal(agency.email, "hola@viajesxalapa.mx");
    assert.equal(agency.bankAccounts[0].cardNumber, "4152313412345678");
    assert.equal(agency.logoPath, "/uploads/logos/agency-a-1.png");
    assert.equal(agency.primaryColor, "#059669");
    assert.equal(agency.secondaryColor, "#047857");
  });

  // Varias cuentas bancarias por agencia (2026-11-24): sin id ni position, ordenadas por position
  // (la consulta las trae ordenadas), y sin los campos sueltos anteriores.
  const BBVA = {
    bankName: "BBVA",
    accountHolder: "Viajes Xalapa SA",
    clabeNumber: "012180015549201823",
    cardNumber: "4152313412345678",
  };
  const SANTANDER = {
    bankName: "Santander",
    accountHolder: "Ana Torres",
    clabeNumber: "014180655012345678",
    cardNumber: null,
  };
  const withAccounts = (
    status: string,
    paymentStatus: string,
    amountPaid: number,
    accounts: unknown[],
  ) => {
    const token = magicTokenWith(status, paymentStatus, amountPaid);
    Object.assign(token.tour.agency, { bankAccounts: accounts });
    return token;
  };
  const LEGACY_KEYS = ["bankName", "accountHolder", "clabeNumber", "cardNumber"];

  for (const accounts of [[], [BBVA], [BBVA, SANTANDER]]) {
    it(`PENDING_PAYMENT: booking.bankAccounts con ${accounts.length} cuenta(s), sin campos sueltos`, async () => {
      mock.method(db.query.magicTokens, "findFirst", (async () =>
        withAccounts("PENDING", "PENDING", 0, accounts)) as never);

      const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
      const { flowState, data } = res.json();

      assert.equal(flowState, "PENDING_PAYMENT");
      assert.deepEqual(data.booking.bankAccounts, accounts);
      for (const key of LEGACY_KEYS) assert.equal(key in data.booking, false, key);
    });

    for (const [status, paymentStatus, paid] of [
      ["CONFIRMED", "PARTIAL", 4500],
      ["CONFIRMED", "PAID", 6000],
    ] as const) {
      it(`${paymentStatus}: agency.bankAccounts con ${accounts.length} cuenta(s), sin campos sueltos`, async () => {
        mock.method(db.query.magicTokens, "findFirst", (async () =>
          withAccounts(status, paymentStatus, paid, accounts)) as never);

        const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
        const { agency } = res.json().data;

        assert.deepEqual(agency.bankAccounts, accounts);
        for (const key of LEGACY_KEYS) assert.equal(key in agency, false, key);
      });
    }
  }

  it("las cuentas no exponen id, position ni auditoría y se piden ordenadas por position", async () => {
    const find = mock.method(db.query.magicTokens, "findFirst", (async () =>
      withAccounts("PENDING", "PENDING", 0, [
        { ...SANTANDER, id: "secreto-id", position: 2, createdByUserId: "u-1" },
      ])) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });

    assert.deepEqual(res.json().data.booking.bankAccounts, [SANTANDER]);
    assert.ok(!res.body.includes("secreto-id"));
    // La consulta pide solo las columnas públicas de cada cuenta, en la misma consulta (sin N+1).
    const query = find.mock.calls[0]!.arguments[0] as unknown as {
      with: { tour: { with: { agency: { with: { bankAccounts: { columns: object } } } } } };
    };
    assert.deepEqual(query.with.tour.with.agency.with.bankAccounts.columns, {
      bankName: true,
      accountHolder: true,
      clabeNumber: true,
      cardNumber: true,
    });
  });

  it("comprobante PDF: sin identidad visual guardada usa los colores por defecto y sin logo", async () => {
    mock.method(db.query.magicTokens, "findFirst", (async () =>
      magicTokenWith("CONFIRMED", "PAID", 6000)) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    const { agency } = res.json().data;

    assert.equal(agency.logoPath, null);
    assert.equal(agency.primaryColor, "#4f46e5");
    assert.equal(agency.secondaryColor, "#4338ca");
    assert.equal(agency.accentColor, null);
  });

  it("estado de cuenta PDF: trae fecha de regreso, lugares apartados y teléfono por pasajero", async () => {
    const token = magicTokenWith("CONFIRMED", "PARTIAL", 4500);
    Object.assign(token.tour, { returnDate: "2026-12-21" });
    token.booking.passengers = [
      {
        isTitular: true,
        status: "ACTIVE",
        seatLabel: "4",
        boardingPoint: null,
        traveler: { fullName: "Ana Torres", whatsappPhone: "2281234567" },
      },
    ] as never;
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const { data } = (
      await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
    ).json();

    assert.equal(data.tourInfo.returnDate, "2026-12-21");
    assert.equal(data.groupSize, 4); // numberPassengers del token
    assert.equal(data.passengers[0].phone, "2281234567");
  });

  it("trae las instrucciones post-pago del tour y las políticas generales de la agencia (o null)", async () => {
    const token = magicTokenWith("CONFIRMED", "PARTIAL", 4500);
    Object.assign(token.tour, {
      postPaymentInstructions: "  Llevar botas de montaña.  ",
    });
    Object.assign(token.tour.agency, { policies: "El anticipo no es reembolsable." });
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const { data } = (
      await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
    ).json();
    assert.equal(data.tourInfo.postPaymentInstructions, "Llevar botas de montaña.");
    assert.equal("policies" in data.tourInfo, false);
    assert.equal(data.agency.policies, "El anticipo no es reembolsable.");

    mock.restoreAll();
    mock.method(db.query.magicTokens, "findFirst", (async () =>
      magicTokenWith("CONFIRMED", "PAID", 6000)) as never);
    const paid = (
      await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
    ).json();
    assert.equal(paid.data.tourInfo.postPaymentInstructions, null); // vacío o ausente → null
    assert.equal(paid.data.agency.policies, null);
  });

  it("registro (PENDING_REGISTRATION): trae las políticas de la agencia recortadas (vacías → null)", async () => {
    const token = magicTokenWith("AWAITING_REGISTRATION", "PENDING", 0);
    Object.assign(token.tour.agency, {
      policies: "  Anticipo no reembolsable.\n\nLlegar 15 min antes.  ",
    });
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    assert.equal(res.json().flowState, "PENDING_REGISTRATION");
    assert.equal(
      res.json().data.agencyPolicies,
      "Anticipo no reembolsable.\n\nLlegar 15 min antes.",
    );

    mock.restoreAll();
    const blank = magicTokenWith("AWAITING_REGISTRATION", "PENDING", 0);
    Object.assign(blank.tour.agency, { policies: "   " });
    mock.method(db.query.magicTokens, "findFirst", (async () => blank) as never);
    const empty = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    assert.equal(empty.json().data.agencyPolicies, null);
  });

  it("registro (PENDING_REGISTRATION): precio por persona = precio pactado, no el precio actual del tour (OBS-040)", async () => {
    // Apartó 4 lugares a $1,500 ($6,000); antes del primer pago el tour subió a $1,800.
    const token = magicTokenWith("AWAITING_REGISTRATION", "PENDING", 0);
    Object.assign(token.booking, { unitPrice: 1500 });
    Object.assign(token.tour, { price: 1800 });
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    const { tourInfo } = res.json().data;
    assert.equal(tourInfo.priceTotalPerPassenger, 1500); // antes: 1800
    // El formulario calcula lugares × precio: cuadra con el total de la reserva.
    assert.equal(tourInfo.priceTotalPerPassenger * tourInfo.reservedSeats, 6000);

    // Reserva anterior sin precio guardado: respaldo total ÷ lugares apartados.
    mock.restoreAll();
    const legacy = magicTokenWith("AWAITING_REGISTRATION", "PENDING", 0);
    Object.assign(legacy.booking, { unitPrice: null });
    Object.assign(legacy.tour, { price: 1800 });
    mock.method(db.query.magicTokens, "findFirst", (async () => legacy) as never);
    const legacyRes = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    assert.equal(legacyRes.json().data.tourInfo.priceTotalPerPassenger, 1500);
  });

  it("todas las vistas reciben la marca de la agencia en meta (incluida una reserva cancelada)", async () => {
    for (const [status, paymentStatus, flowState] of [
      ["CANCELLED", "PARTIAL", "CANCELLED"],
      ["AWAITING_REGISTRATION", "PENDING", "PENDING_REGISTRATION"],
      ["CONFIRMED", "PAID", "PAID"],
    ] as const) {
      const token = magicTokenWith(status, paymentStatus, 0);
      Object.assign(token.tour.agency, { logoPath: "/uploads/logos/agency-a-1.png" });
      mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

      const res = (
        await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
      ).json();
      assert.equal(res.flowState, flowState);
      assert.deepEqual(res.meta.agency, {
        name: "Viajes Xalapa",
        logoPath: "/uploads/logos/agency-a-1.png",
        phone: "2281234567",
        // Domicilio del responsable para el aviso de privacidad simplificado (2026-11-22).
        address: null,
      });
      mock.restoreAll();
    }
  });
});

/**
 * Bug del 2026-11-24: tras transferir la titularidad y dar de baja a un acompañante
 * (booking_passengers.status = CANCELLED, numberPassengers − 1), el Magic Link seguía mostrando
 * al acompañante cancelado y, en PENDING_PAYMENT, inflaba el anticipo con él.
 */
describe("Magic Link: solo muestra a los pasajeros vigentes (ACTIVE)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  /** Titular transferido (Carlos, viajero nuevo) + acompañantes; `numberPassengers` ya descontó la baja. */
  function tokenWithGroup(
    status: string,
    paymentStatus: string,
    numberPassengers: number,
    passengers: unknown[],
  ) {
    const token = magicTokenWith(status, paymentStatus, paymentStatus === "PENDING" ? 0 : 1000);
    token.numberPassengers = numberPassengers;
    token.booking.passengers = passengers as never;
    return token;
  }

  const titular = {
    isTitular: true,
    status: "ACTIVE",
    passengerType: "ADULT",
    boardingPoint: "Plaza (06:00)",
    traveler: {
      fullName: "Carlos Ruiz",
      whatsappPhone: "+522281112233",
      whatsappCountry: "MX",
      email: "carlos@correo.mx",
      emergencyContactName: "Rosa Ruiz",
      emergencyContactPhone: "+522289998877",
      emergencyContactCountry: "MX",
      birthDate: "1980-05-01",
    },
  };
  const activeCompanion = {
    isTitular: false,
    status: "ACTIVE",
    passengerType: "ADULT",
    boardingPoint: "Plaza (06:00)",
    traveler: { fullName: "Luis Torres", birthDate: "1990-01-01" },
  };
  const cancelledMinor = {
    isTitular: false,
    status: "CANCELLED",
    passengerType: "CHILD",
    boardingPoint: "Plaza (06:00)",
    traveler: { fullName: "Mía Torres", birthDate: null },
  };

  it("titular y acompañante activos: ambos aparecen (PENDING_PAYMENT)", async () => {
    const token = tokenWithGroup("PENDING", "PENDING", 2, [titular, activeCompanion]);
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const { flowState, data } = (
      await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
    ).json();

    assert.equal(flowState, "PENDING_PAYMENT");
    assert.equal(data.booking.titularName, "Carlos Ruiz");
    assert.deepEqual(data.booking.companionNames, ["Luis Torres"]);
    assert.equal(data.booking.passengers.length, 2);
    assert.equal(data.booking.depositAmount, 1000); // $500 × 2 lugares
  });

  it("PENDING_PAYMENT: excluye al acompañante cancelado; anticipo = depósito × numberPassengers", async () => {
    // Titular transferido + acompañante dado de baja: el grupo queda en un solo viajero.
    const token = tokenWithGroup("PENDING", "PENDING", 1, [titular, cancelledMinor]);
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
    const { data } = res.json();

    assert.equal(data.booking.titularName, "Carlos Ruiz");
    assert.equal(data.titularName, "Carlos Ruiz");
    assert.deepEqual(data.booking.companionNames, []);
    assert.deepEqual(
      data.booking.passengers.map((p: { name: string; isTitular: boolean }) => [
        p.name,
        p.isTitular,
      ]),
      [["Carlos Ruiz", true]],
    );
    assert.equal(data.booking.hasMinors, false); // el menor cancelado no cuenta
    assert.equal(data.booking.depositAmount, 500); // antes: $500 × 2 filas = $1,000
    assert.ok(!res.body.includes("Mía Torres"));
  });

  it("PENDING_PAYMENT: el anticipo usa los lugares apartados aunque haya menos filas registradas", async () => {
    const token = tokenWithGroup("PENDING", "PENDING", 3, [titular]);
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const { data } = (
      await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
    ).json();
    assert.equal(data.booking.depositAmount, 1500); // $500 × 3 lugares (regla 8)
  });

  for (const paymentStatus of ["PARTIAL", "PAID"] as const) {
    it(`${paymentStatus}: varios acompañantes con la baja de uno; hasMinors ignora al menor cancelado`, async () => {
      const otherCompanion = {
        ...activeCompanion,
        traveler: { fullName: "Eva Torres", birthDate: "1992-03-03" },
      };
      const token = tokenWithGroup("CONFIRMED", paymentStatus, 3, [
        titular,
        activeCompanion,
        cancelledMinor,
        otherCompanion,
      ]);
      mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

      const res = await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" });
      const { data } = res.json();

      assert.deepEqual(
        data.passengers.map((p: { name: string; type: string; status: string }) => [
          p.name,
          p.type,
          p.status,
        ]),
        [
          ["Carlos Ruiz", "Titular", "ACTIVE"],
          ["Luis Torres", "Acompañante", "ACTIVE"],
          ["Eva Torres", "Acompañante", "ACTIVE"],
        ],
      );
      assert.equal(data.hasMinors, false);
      assert.equal(data.groupSize, 3);
      assert.ok(!res.body.includes("Mía Torres"));
    });
  }

  it("PAID: grupo que queda en un solo viajero tras la baja del acompañante", async () => {
    const token = tokenWithGroup("CONFIRMED", "PAID", 1, [
      titular,
      { ...activeCompanion, status: "CANCELLED" },
    ]);
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const { data } = (
      await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
    ).json();
    assert.deepEqual(
      data.passengers.map((p: { name: string; isTitular: boolean }) => [p.name, p.isTitular]),
      [["Carlos Ruiz", true]],
    );
    assert.equal(data.groupSize, 1);
  });

  it("PENDING_REGISTRATION: prefill con el titular vigente (transferido), no con uno cancelado", async () => {
    // Fila cancelada marcada como titular primero: el prefill no debe tomarla.
    const staleTitular = {
      ...titular,
      status: "CANCELLED",
      boardingPoint: "Oxxo",
      traveler: { ...titular.traveler, fullName: "Ana Torres", email: "ana@correo.mx" },
    };
    const token = tokenWithGroup("AWAITING_REGISTRATION", "PENDING", 2, [staleTitular, titular]);
    mock.method(db.query.magicTokens, "findFirst", (async () => token) as never);

    const { flowState, data } = (
      await app.inject({ method: "GET", url: "/api/magic-tokens/tok/validate" })
    ).json();

    assert.equal(flowState, "PENDING_REGISTRATION");
    assert.equal(data.prefillData.fullName, "Carlos Ruiz");
    assert.equal(data.prefillData.email, "carlos@correo.mx");
    assert.equal(data.prefillData.whatsappPhone, "+522281112233");
    assert.equal(data.prefillData.boardingPoint, "Plaza (06:00)");
  });
});
