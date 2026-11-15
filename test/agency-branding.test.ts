import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db/index.js";
import {
  AgencyBrandingService,
  LOGOS_DIR,
} from "../src/modules/agencies/agency-branding.service.js";
import { AGENCY_A, USER_A, createTestApp, sessionCookie, type TestApp } from "./helpers.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Cuerpo multipart/form-data con un solo archivo `file`. */
function multipart(fileName: string, contentType: string, content: Buffer) {
  const boundary = "----tripagent-test";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const logoFiles = () =>
  fs.existsSync(LOGOS_DIR)
    ? fs.readdirSync(LOGOS_DIR).filter((f) => f.startsWith(`agency-${AGENCY_A}-`))
    : [];

describe("Identidad visual de la agencia (colores + logotipo físico)", () => {
  let app: TestApp;
  before(async () => {
    app = await createTestApp();
  });
  after(async () => {
    for (const f of logoFiles()) fs.unlinkSync(path.join(LOGOS_DIR, f));
    await app.close();
  });
  afterEach(() => mock.restoreAll());

  it("GET /branding sin sesión responde 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agencies/branding" });
    assert.equal(res.statusCode, 401);
  });

  it("GET /branding sin fila en agency_branding devuelve los colores por defecto de la agencia de la sesión", async () => {
    const find = mock.method(db.query.agencies, "findFirst", (async () => ({
      logoPath: null,
      branding: null,
    })) as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/agencies/branding",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(find.mock.callCount(), 1);
    assert.deepEqual(res.json().data, {
      logoPath: null,
      primaryColor: "#4f46e5",
      secondaryColor: "#4338ca",
      accentColor: null,
    });
  });

  it("PATCH /branding normaliza el hex (#RGB → #rrggbb) y guarda en la agencia de la sesión", async () => {
    const update = mock.method(
      AgencyBrandingService,
      "updateColors",
      async (agencyId: string, body: Record<string, unknown>) =>
        ({ logoPath: null, accentColor: null, ...body, agencyId }) as never,
    );

    const res = await app.inject({
      method: "PATCH",
      url: "/api/agencies/branding",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { primaryColor: "#0F172A", secondaryColor: "#abc" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(update.mock.calls[0]?.arguments[0], AGENCY_A);
    assert.deepEqual(update.mock.calls[0]?.arguments[1], {
      primaryColor: "#0f172a",
      secondaryColor: "#aabbcc",
    });
  });

  it("PATCH /branding rechaza colores que no son hex (400) sin escribir", async () => {
    const update = mock.method(AgencyBrandingService, "updateColors", async () => null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/agencies/branding",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      payload: { primaryColor: "indigo" },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(update.mock.callCount(), 0);
  });

  it("POST /logo guarda el PNG en public/uploads/logos y reemplaza la ruta en agencies.logoPath", async () => {
    const setPath = mock.method(AgencyBrandingService, "setLogoPath", async () => ({
      previousLogoPath: null,
    }));
    mock.method(AgencyBrandingService, "getBranding", async () => ({
      logoPath: "/uploads/logos/x.png",
      primaryColor: "#4f46e5",
      secondaryColor: "#4338ca",
      accentColor: null,
    }));

    const res = await app.inject({
      method: "POST",
      url: "/api/agencies/logo",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      ...multipart("logo.png", "image/png", PNG_BYTES),
    });

    assert.equal(res.statusCode, 200);
    const [agencyId, savedPath] = setPath.mock.calls[0]?.arguments ?? [];
    assert.equal(agencyId, AGENCY_A);
    assert.match(String(savedPath), new RegExp(`^/uploads/logos/agency-${AGENCY_A}-\\d+\\.png$`));
    assert.ok(fs.existsSync(path.join(LOGOS_DIR, path.basename(String(savedPath)))));
  });

  it("POST /logo rechaza SVG (jsPDF no lo puede insertar) sin tocar la base", async () => {
    const setPath = mock.method(AgencyBrandingService, "setLogoPath", async () => ({
      previousLogoPath: null,
    }));
    const before = logoFiles().length;

    const res = await app.inject({
      method: "POST",
      url: "/api/agencies/logo",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      ...multipart("logo.svg", "image/svg+xml", Buffer.from("<svg/>")),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(setPath.mock.callCount(), 0);
    assert.equal(logoFiles().length, before);
  });

  it("POST /logo rechaza archivos de más de 2 MB y no deja el archivo en disco", async () => {
    const setPath = mock.method(AgencyBrandingService, "setLogoPath", async () => ({
      previousLogoPath: null,
    }));
    const before = logoFiles().length;

    const res = await app.inject({
      method: "POST",
      url: "/api/agencies/logo",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
      ...multipart("logo.png", "image/png", Buffer.alloc(2 * 1024 * 1024 + 10)),
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /2 MB/);
    assert.equal(setPath.mock.callCount(), 0);
    assert.equal(logoFiles().length, before);
  });

  it("DELETE /logo quita la ruta y borra el archivo anterior", async () => {
    fs.mkdirSync(LOGOS_DIR, { recursive: true });
    const oldName = `agency-${AGENCY_A}-1.png`;
    fs.writeFileSync(path.join(LOGOS_DIR, oldName), PNG_BYTES);
    const setPath = mock.method(AgencyBrandingService, "setLogoPath", async () => ({
      previousLogoPath: `/uploads/logos/${oldName}`,
    }));
    mock.method(AgencyBrandingService, "getBranding", async () => null as never);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/agencies/logo",
      cookies: sessionCookie(app, AGENCY_A, USER_A),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(setPath.mock.calls[0]?.arguments, [AGENCY_A, null]);
    assert.equal(fs.existsSync(path.join(LOGOS_DIR, oldName)), false);
  });

  it("el logotipo se sirve en /public con CORS para que el front lo inserte en el PDF", async () => {
    fs.mkdirSync(LOGOS_DIR, { recursive: true });
    const name = `agency-${AGENCY_A}-cors.png`;
    fs.writeFileSync(path.join(LOGOS_DIR, name), PNG_BYTES);

    const res = await app.inject({
      method: "GET",
      url: `/public/uploads/logos/${name}`,
      headers: { origin: "http://localhost:3000" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:3000");
  });
});
