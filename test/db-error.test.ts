import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DrizzleQueryError } from "drizzle-orm";
import { getErrorCode } from "../src/shared/utils/db-error.util.js";

describe("getErrorCode: código de Postgres con y sin el envoltorio de Drizzle", () => {
  const pgError = (code: string) => Object.assign(new Error("pg"), { code });

  it("lee el código directo (driver sin envolver o error de Fastify)", () => {
    assert.equal(getErrorCode(pgError("23505")), "23505");
    assert.equal(getErrorCode(pgError("FST_REQ_FILE_TOO_LARGE")), "FST_REQ_FILE_TOO_LARGE");
  });

  it("lee el código en `cause` de un DrizzleQueryError (Drizzle 0.45)", () => {
    assert.equal(getErrorCode(new DrizzleQueryError("insert", [], pgError("23505"))), "23505");
    assert.equal(getErrorCode(new DrizzleQueryError("delete", [], pgError("23503"))), "23503");
  });

  it("sin código o con algo que no es Error → undefined", () => {
    assert.equal(getErrorCode(new Error("x")), undefined);
    assert.equal(getErrorCode(new DrizzleQueryError("q", [], undefined as never)), undefined);
    assert.equal(getErrorCode({ code: "23505" }), undefined);
    assert.equal(getErrorCode(null), undefined);
  });
});
