import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getTourLastActiveDate,
  getTourTemporalStatus,
} from "../src/shared/utils/tour-status.util.js";

// Regla 9 de ../CLAUDE.md (corregida el 2026-11-15): EN CURSO va de la salida al regreso (inclusive);
// sin fecha de regreso, el día de salida y el siguiente. Antes se ignoraba el regreso: "Zacatlán de
// las manzanas" (salida y regreso el 14 de noviembre) seguía EN CURSO el 15.

/** Mediodía en CDMX (UTC−6) del día indicado. */
const atMexicoNoon = (date: string) => new Date(`${date}T18:00:00Z`);

describe("getTourTemporalStatus usa la fecha de regreso", () => {
  it("tour de un día: EN CURSO el día de salida y FINALIZADO al día siguiente", () => {
    const status = (today: string) =>
      getTourTemporalStatus("2026-11-14", null, "2026-11-14", atMexicoNoon(today));
    assert.equal(status("2026-11-13"), "PRÓXIMO");
    assert.equal(status("2026-11-14"), "EN CURSO");
    assert.equal(status("2026-11-15"), "FINALIZADO");
  });

  it("tour de varios días: EN CURSO hasta el día de regreso, inclusive", () => {
    const status = (today: string) =>
      getTourTemporalStatus("2026-11-20", null, "2026-11-23", atMexicoNoon(today));
    assert.equal(status("2026-11-22"), "EN CURSO");
    assert.equal(status("2026-11-23"), "EN CURSO");
    assert.equal(status("2026-11-24"), "FINALIZADO");
  });

  it("sin fecha de regreso conserva la tolerancia de un día", () => {
    const status = (today: string) =>
      getTourTemporalStatus("2026-11-14", null, null, atMexicoNoon(today));
    assert.equal(status("2026-11-15"), "EN CURSO");
    assert.equal(status("2026-11-16"), "FINALIZADO");
  });

  it("un regreso anterior a la salida (dato inválido) se ignora", () => {
    assert.equal(getTourLastActiveDate("2026-11-14", "2026-11-10"), "2026-11-15");
  });

  it("usa el día de CDMX, no el de UTC", () => {
    // 2026-11-15 03:00 UTC = 2026-11-14 21:00 en CDMX: el tour de un día sigue EN CURSO.
    assert.equal(
      getTourTemporalStatus("2026-11-14", null, "2026-11-14", new Date("2026-11-15T03:00:00Z")),
      "EN CURSO",
    );
  });

  it("la cancelación manda sobre las fechas", () => {
    assert.equal(
      getTourTemporalStatus("2026-11-14", "2026-11-13T10:00:00.000Z", "2026-11-14"),
      "CANCELADO",
    );
  });
});
