import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { db } from "../src/db/index.js";
import { agencies, agencyBankAccounts } from "../src/db/schema.js";
import {
  AGENCY_A,
  AGENCY_B,
  USER_A,
  createTestApp,
  rowMatches,
  sessionCookie,
  type TestApp,
} from "./helpers.js";

/**
 * Cuentas bancarias de la agencia (2026-11-24): `GET/POST/PATCH/DELETE /agencies/bank-accounts`.
 * Base en memoria mínima: evalúa los WHERE de Drizzle con `rowMatches`, aplica el índice único
 * `(agency_id, clabe_number)` (lanza 23505 envuelto en `DrizzleQueryError`, como Drizzle) y revierte
 * la transacción si la función lanza.
 */

type Row = Record<string, unknown>;

const CLABE_1 = "012180015549201823";
const CLABE_2 = "014180655012345678";
const OTHER_AGENCY_ACCOUNT = "b0b0b0b0-0000-4000-8000-000000000001";

function accountRow(overrides: Row): Row {
  return {
    id: crypto.randomUUID(),
    agencyId: AGENCY_A,
    bankName: "BBVA",
    accountHolder: "Viajes Xalapa SA",
    clabeNumber: CLABE_1,
    cardNumber: null,
    position: 1,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: "2026-11-24T00:00:00.000Z",
    updatedAt: "2026-11-24T00:00:00.000Z",
    ...overrides,
  };
}

function fakeBankAccountsDb(initial: Row[], opts: { staleAccountsRead?: boolean } = {}) {
  let accounts = initial.map((row) => ({ ...row }));
  const agencyRows: Row[] = [{ id: AGENCY_A }, { id: AGENCY_B }];
  const locks: string[] = [];

  const project = (row: Row, fields: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]));

  const assertUnique = (candidate: Row) => {
    const clash = accounts.some(
      (row) =>
        row.id !== candidate.id &&
        row.agencyId === candidate.agencyId &&
        row.clabeNumber === candidate.clabeNumber,
    );
    if (clash) {
      throw new DrizzleQueryError(
        "insert/update agency_bank_accounts",
        [],
        Object.assign(new Error("duplicate key value"), { code: "23505" }),
      );
    }
  };

  const ops = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (where: SQL) => {
          const source = table === agencies ? agencyRows : accounts;
          const rows =
            table === agencyBankAccounts && opts.staleAccountsRead
              ? []
              : source.filter((row) => rowMatches(where, row)).map((row) => project(row, fields));
          return Object.assign(Promise.resolve(rows), {
            for: (mode: string) => {
              if (table === agencies) locks.push(`agencies:${mode}`);
              return Promise.resolve(rows);
            },
          });
        },
      }),
    }),
    insert: (table: unknown) => {
      assert.equal(table, agencyBankAccounts);
      return {
        values: (values: Row) => ({
          returning: async (fields: Record<string, unknown>) => {
            const row = accountRow({ cardNumber: null, ...values, id: crypto.randomUUID() });
            assertUnique(row);
            accounts.push(row);
            return [project(row, fields)];
          },
        }),
      };
    },
    update: (table: unknown) => {
      assert.equal(table, agencyBankAccounts);
      return {
        set: (values: Row) => ({
          where: (where: SQL) => ({
            returning: async (fields: Record<string, unknown>) => {
              const targets = accounts.filter((row) => rowMatches(where, row));
              const updated = targets.map((row) => ({ ...row, ...values }));
              updated.forEach(assertUnique);
              accounts = accounts.map((row) => updated.find((u) => u.id === row.id) ?? row);
              return updated.map((row) => project(row, fields));
            },
          }),
        }),
      };
    },
    delete: (table: unknown) => {
      assert.equal(table, agencyBankAccounts);
      return {
        where: (where: SQL) => ({
          returning: async (fields: Record<string, unknown>) => {
            const removed = accounts.filter((row) => rowMatches(where, row));
            accounts = accounts.filter((row) => !removed.includes(row));
            return removed.map((row) => project(row, fields));
          },
        }),
      };
    },
  };

  mock.method(db, "select", ops.select as never);
  mock.method(db, "insert", ops.insert as never);
  mock.method(db, "update", ops.update as never);
  mock.method(db, "delete", ops.delete as never);
  mock.method(db, "transaction", (async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = accounts.map((row) => ({ ...row }));
    try {
      return await fn(ops);
    } catch (error) {
      accounts = snapshot;
      throw error;
    }
  }) as never);
  mock.method(db.query.agencyBankAccounts, "findMany", (async (config: {
    where: SQL;
    columns: Record<string, boolean>;
  }) =>
    accounts
      .filter((row) => rowMatches(config.where, row))
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((row) => project(row, config.columns))) as never);

  return { rows: () => accounts, locks };
}

describe("/api/agencies/bank-accounts (cuentas bancarias de la agencia)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  const request = (method: "GET" | "POST" | "PATCH" | "DELETE", path = "", payload?: object) =>
    app.inject({
      method,
      url: `/api/agencies/bank-accounts${path}`,
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      ...(payload ? { payload } : {}),
    });

  const newAccount = {
    bankName: "  BBVA ",
    accountHolder: " Viajes Xalapa SA ",
    clabeNumber: ` ${CLABE_1} `,
  };

  describe("POST", () => {
    let fake: ReturnType<typeof fakeBankAccountsDb>;
    beforeEach(() => {
      fake = fakeBankAccountsDb([
        accountRow({ id: OTHER_AGENCY_ACCOUNT, agencyId: AGENCY_B, position: 1 }),
      ]);
    });

    it("201 con la cuenta creada (recortada, tarjeta null, position 1) y auditoría del usuario", async () => {
      const res = await request("POST", "", newAccount);

      assert.equal(res.statusCode, 201);
      const { data } = res.json();
      assert.deepEqual(Object.keys(data).sort(), [
        "accountHolder",
        "bankName",
        "cardNumber",
        "clabeNumber",
        "id",
        "position",
      ]);
      assert.equal(data.bankName, "BBVA");
      assert.equal(data.accountHolder, "Viajes Xalapa SA");
      assert.equal(data.clabeNumber, CLABE_1);
      assert.equal(data.cardNumber, null);
      // La misma CLABE en otra agencia no choca: el índice único es por agencia.
      assert.equal(data.position, 1);
      const saved = fake.rows().find((row) => row.id === data.id)!;
      assert.equal(saved.agencyId, AGENCY_A);
      assert.equal(saved.createdByUserId, USER_A);
      assert.equal(saved.updatedByUserId, USER_A);
      // El límite se revisa con la fila de la agencia bloqueada.
      assert.deepEqual(fake.locks, ["agencies:update"]);
    });

    it("tarjeta de 16 dígitos se guarda; vacía → null; otra longitud → 400", async () => {
      const withCard = await request("POST", "", { ...newAccount, cardNumber: "4152313412345678" });
      assert.equal(withCard.json().data.cardNumber, "4152313412345678");

      const empty = await request("POST", "", {
        ...newAccount,
        clabeNumber: CLABE_2,
        cardNumber: "",
      });
      assert.equal(empty.statusCode, 201);
      assert.equal(empty.json().data.cardNumber, null);

      const invalid = await request("POST", "", {
        ...newAccount,
        clabeNumber: "000000000000000001",
        cardNumber: "4111",
      });
      assert.equal(invalid.statusCode, 400);
      assert.match(invalid.body, /16 dígitos/);
    });

    it("400 sin banco, sin titular o con CLABE que no tiene 18 dígitos (sin escribir)", async () => {
      for (const payload of [
        { ...newAccount, bankName: "  " },
        { ...newAccount, accountHolder: "" },
        { ...newAccount, clabeNumber: "12345" },
        { ...newAccount, clabeNumber: "01234567890123456A" },
      ]) {
        const res = await request("POST", "", payload);
        assert.equal(res.statusCode, 400, JSON.stringify(payload));
      }
      assert.equal(fake.rows().length, 1);
    });

    it("409 si la agencia ya tiene una cuenta con esa CLABE", async () => {
      await request("POST", "", newAccount);
      const res = await request("POST", "", newAccount);

      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, "Ya registraste una cuenta con esa CLABE");
    });

    it("409 al llegar al límite de 2 cuentas (sin escribir la tercera)", async () => {
      for (let i = 1; i <= 2; i++) {
        const res = await request("POST", "", {
          ...newAccount,
          clabeNumber: `00000000000000000${i}`,
        });
        assert.equal(res.statusCode, 201);
        assert.equal(res.json().data.position, i);
      }

      const res = await request("POST", "", { ...newAccount, clabeNumber: "000000000000000003" });

      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, "Puedes registrar hasta 2 cuentas bancarias");
      assert.equal(fake.rows().filter((row) => row.agencyId === AGENCY_A).length, 2);
    });
  });

  it("POST: dos altas simultáneas con la misma CLABE → el índice único (23505) responde 409", async () => {
    // La lectura previa no ve la otra alta (carrera): la detiene el índice único.
    fakeBankAccountsDb([accountRow({ position: 1 })], { staleAccountsRead: true });

    const res = await request("POST", "", newAccount);

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "Ya registraste una cuenta con esa CLABE");
  });

  it("POST: después de borrar, la nueva cuenta sigue desde la mayor position (sin renumerar)", async () => {
    // La cuenta en position 1 se borró: queda la 2 y la nueva sigue desde la mayor (3).
    const fake = fakeBankAccountsDb([
      accountRow({ clabeNumber: "000000000000000003", position: 2 }),
    ]);

    const res = await request("POST", "", { ...newAccount, clabeNumber: CLABE_2 });

    assert.equal(res.json().data.position, 3);
    assert.deepEqual(
      fake.rows().map((row) => row.position),
      [2, 3],
    );
  });

  it("GET: solo las cuentas de la agencia de la sesión, ordenadas por position", async () => {
    fakeBankAccountsDb([
      accountRow({ id: "a-3", clabeNumber: "000000000000000003", position: 3 }),
      accountRow({ id: OTHER_AGENCY_ACCOUNT, agencyId: AGENCY_B }),
      accountRow({
        id: "a-1",
        clabeNumber: "000000000000000001",
        position: 1,
        cardNumber: "4152313412345678",
      }),
    ]);

    const res = await request("GET");

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, [
      {
        id: "a-1",
        bankName: "BBVA",
        accountHolder: "Viajes Xalapa SA",
        clabeNumber: "000000000000000001",
        cardNumber: "4152313412345678",
        position: 1,
      },
      {
        id: "a-3",
        bankName: "BBVA",
        accountHolder: "Viajes Xalapa SA",
        clabeNumber: "000000000000000003",
        cardNumber: null,
        position: 3,
      },
    ]);
  });

  describe("PATCH /:id", () => {
    const ID_1 = "c1c1c1c1-0000-4000-8000-000000000001";
    const ID_2 = "c1c1c1c1-0000-4000-8000-000000000002";
    let fake: ReturnType<typeof fakeBankAccountsDb>;
    beforeEach(() => {
      fake = fakeBankAccountsDb([
        // Registro migrado: banco y titular vacíos (válido para leer).
        accountRow({
          id: ID_1,
          bankName: "",
          accountHolder: "",
          position: 1,
          cardNumber: "4152313412345678",
        }),
        accountRow({ id: ID_2, clabeNumber: CLABE_2, position: 2 }),
        accountRow({ id: OTHER_AGENCY_ACCOUNT, agencyId: AGENCY_B, clabeNumber: CLABE_2 }),
      ]);
    });

    it("parcial: solo escribe los campos enviados y registra quién editó", async () => {
      const res = await request("PATCH", `/${ID_1}`, { bankName: " Banorte " });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data, {
        id: ID_1,
        bankName: "Banorte",
        accountHolder: "",
        clabeNumber: CLABE_1,
        cardNumber: "4152313412345678",
        position: 1,
      });
      const saved = fake.rows().find((row) => row.id === ID_1)!;
      assert.equal(saved.updatedByUserId, USER_A);
      assert.notEqual(saved.updatedAt, "2026-11-24T00:00:00.000Z");
    });

    it("tarjeta vacía o null la quita", async () => {
      for (const cardNumber of ["", null]) {
        const res = await request("PATCH", `/${ID_1}`, { cardNumber });
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().data.cardNumber, null);
      }
    });

    it("400 sin campos o con banco vacío (al editar se exigen)", async () => {
      assert.equal((await request("PATCH", `/${ID_1}`, {})).statusCode, 400);
      assert.equal((await request("PATCH", `/${ID_1}`, { bankName: " " })).statusCode, 400);
    });

    it("409 si la CLABE ya es de otra cuenta de la agencia; conservar la propia sí se permite", async () => {
      const duplicate = await request("PATCH", `/${ID_1}`, { clabeNumber: CLABE_2 });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().error, "Ya registraste una cuenta con esa CLABE");

      const same = await request("PATCH", `/${ID_1}`, { clabeNumber: CLABE_1 });
      assert.equal(same.statusCode, 200);
    });

    it("404 con la cuenta de otra agencia o inexistente (sin escribir)", async () => {
      const foreign = await request("PATCH", `/${OTHER_AGENCY_ACCOUNT}`, { bankName: "Robado" });
      assert.equal(foreign.statusCode, 404);
      assert.equal(foreign.json().error, "Cuenta bancaria no encontrada");
      assert.equal(fake.rows().find((row) => row.id === OTHER_AGENCY_ACCOUNT)!.bankName, "BBVA");

      const missing = await request("PATCH", "/c1c1c1c1-0000-4000-8000-00000000ffff", {
        bankName: "X",
      });
      assert.equal(missing.statusCode, 404);
    });
  });

  describe("DELETE /:id", () => {
    const ID_1 = "d1d1d1d1-0000-4000-8000-000000000001";

    it("borra la última cuenta (se permite, regla 22) → { data: { id } }", async () => {
      const fake = fakeBankAccountsDb([accountRow({ id: ID_1 })]);

      const res = await request("DELETE", `/${ID_1}`);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { data: { id: ID_1 } });
      assert.equal(fake.rows().length, 0);
    });

    it("404 con la cuenta de otra agencia (sin borrar)", async () => {
      const fake = fakeBankAccountsDb([
        accountRow({ id: OTHER_AGENCY_ACCOUNT, agencyId: AGENCY_B }),
      ]);

      const res = await request("DELETE", `/${OTHER_AGENCY_ACCOUNT}`);

      assert.equal(res.statusCode, 404);
      assert.equal(fake.rows().length, 1);
    });
  });

  it("sin sesión → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agencies/bank-accounts" });
    assert.equal(res.statusCode, 401);
  });
});

describe("/api/agencies/bank-accounts en Modo Solo Lectura", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp({ isAgencyReadOnly: async () => true });
  });
  after(async () => {
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("POST, PATCH y DELETE → 402 sin escribir; GET sigue disponible", async () => {
    const fake = fakeBankAccountsDb([accountRow({ id: "e1e1e1e1-0000-4000-8000-000000000001" })]);
    const cookies = sessionCookie(app, AGENCY_A, USER_A);
    const url = "/api/agencies/bank-accounts";
    const id = "e1e1e1e1-0000-4000-8000-000000000001";

    for (const [method, path, payload] of [
      ["POST", "", { bankName: "BBVA", accountHolder: "Ana", clabeNumber: CLABE_2 }],
      ["PATCH", `/${id}`, { bankName: "Banorte" }],
      ["DELETE", `/${id}`, undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url: `${url}${path}`,
        cookies,
        ...(payload ? { payload } : {}),
      });
      assert.equal(res.statusCode, 402, method);
      assert.equal(res.json().code, "SUBSCRIPTION_READ_ONLY");
    }
    assert.equal(fake.rows().length, 1);
    assert.equal(fake.rows()[0]!.bankName, "BBVA");

    const list = await app.inject({ method: "GET", url, cookies });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.length, 1);
  });
});
