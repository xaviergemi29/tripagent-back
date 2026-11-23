import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import {
  CLIENT_IP_HEADER,
  INTERNAL_SECRET_HEADER,
  getClientIp,
  redactSensitiveUrl,
  resolveInternalProxySecret,
} from "../src/shared/security/client-ip.js";
import { SecurityConfigError } from "../src/shared/security/security.config.js";
import { RATE_LIMITS } from "../src/shared/security/rate-limits.js";

// IP real del visitante en las rutas públicas que el front pide desde su servidor, y URLs sin
// tokens ni teléfonos en el log (2026-11-22).

const SECRET = "s".repeat(40);
const NEXT_SERVER_IP = "10.0.0.5";

const fakeRequest = (headers: Record<string, string> = {}) =>
  ({ ip: NEXT_SERVER_IP, headers }) as unknown as FastifyRequest;

describe("resolveInternalProxySecret", () => {
  it("es opcional: sin variable devuelve null", () => {
    assert.equal(resolveInternalProxySecret({}), null);
    assert.equal(resolveInternalProxySecret({ INTERNAL_PROXY_SECRET: "  " }), null);
  });

  it("falla cerrado si se define con menos de 32 caracteres", () => {
    assert.throws(
      () => resolveInternalProxySecret({ INTERNAL_PROXY_SECRET: "corto" }),
      SecurityConfigError,
    );
  });

  it("acepta un secreto fuerte", () => {
    assert.equal(resolveInternalProxySecret({ INTERNAL_PROXY_SECRET: SECRET }), SECRET);
  });
});

describe("getClientIp", () => {
  const env = { INTERNAL_PROXY_SECRET: SECRET };

  it("usa la IP reenviada solo con el secreto correcto", () => {
    const request = fakeRequest({
      [INTERNAL_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: "187.190.1.20",
    });
    assert.equal(getClientIp(request, env), "187.190.1.20");
  });

  it("acepta IPv6", () => {
    const request = fakeRequest({
      [INTERNAL_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: "2806:2f0::1",
    });
    assert.equal(getClientIp(request, env), "2806:2f0::1");
  });

  it("ignora la cabecera sin secreto o con uno incorrecto (un navegador no puede falsificar su IP)", () => {
    assert.equal(getClientIp(fakeRequest({ [CLIENT_IP_HEADER]: "1.2.3.4" }), env), NEXT_SERVER_IP);
    assert.equal(
      getClientIp(
        fakeRequest({ [INTERNAL_SECRET_HEADER]: "x".repeat(40), [CLIENT_IP_HEADER]: "1.2.3.4" }),
        env,
      ),
      NEXT_SERVER_IP,
    );
  });

  it("ignora una IP mal formada", () => {
    const request = fakeRequest({
      [INTERNAL_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: "1.2.3.4, 5.6.7.8",
    });
    assert.equal(getClientIp(request, env), NEXT_SERVER_IP);
  });

  it("sin INTERNAL_PROXY_SECRET siempre usa request.ip", () => {
    const request = fakeRequest({
      [INTERNAL_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: "1.2.3.4",
    });
    assert.equal(getClientIp(request, {}), NEXT_SERVER_IP);
  });
});

describe("límites públicos por IP del visitante", () => {
  const original = process.env.INTERNAL_PROXY_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.INTERNAL_PROXY_SECRET;
    else process.env.INTERNAL_PROXY_SECRET = original;
  });

  it("staffShare y publicRead usan la IP reenviada como clave", () => {
    process.env.INTERNAL_PROXY_SECRET = SECRET;
    const request = fakeRequest({
      [INTERNAL_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: "187.190.1.20",
    });
    assert.equal(RATE_LIMITS.staffShare.keyGenerator(request), "187.190.1.20");
    assert.equal(RATE_LIMITS.publicRead.keyGenerator(request), "187.190.1.20");
  });

  it("el enlace de staff permite 120 cargas cada 10 minutos", () => {
    assert.equal(RATE_LIMITS.staffShare.max, 120);
    assert.equal(RATE_LIMITS.staffShare.timeWindow, 10 * 60 * 1000);
  });
});

describe("redactSensitiveUrl", () => {
  it("oculta el token del enlace de staff", () => {
    assert.equal(
      redactSensitiveUrl("/api/public/staff-share/AbC_123-xyz"),
      "/api/public/staff-share/***",
    );
  });

  it("oculta el token del Magic Link y el teléfono de lookup-traveler", () => {
    assert.equal(
      redactSensitiveUrl("/api/magic-tokens/abc123/lookup-traveler?phone=%2B522281234567"),
      "/api/magic-tokens/***/lookup-traveler?phone=***",
    );
    assert.equal(
      redactSensitiveUrl("/api/magic-tokens/abc123/validate"),
      "/api/magic-tokens/***/validate",
    );
    assert.equal(redactSensitiveUrl("/register?token=abc&x=1"), "/register?token=***&x=1");
  });

  it("no toca las demás rutas", () => {
    assert.equal(redactSensitiveUrl("/api/tours/123?limit=100"), "/api/tours/123?limit=100");
  });
});
