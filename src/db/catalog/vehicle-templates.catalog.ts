import type { LayoutCell, LayoutMap } from "../../shared/utils/vehicle-layout.util.js";

/**
 * Catálogo de plantillas de vehículos de TripAgent (fuente versionada).
 *
 * `npm run vehicle-templates:sync` lo copia a la tabla `vehicle_templates` (upsert por `code`).
 * Para agregar un modelo: añade una entrada aquí y ejecuta el script. Los componentes no cambian.
 *
 * Las plantillas son INMUTABLES una vez sincronizadas: el script rechaza cambiar el croquis de un
 * `code` existente, porque las agencias ya copiaron ese croquis y sus tours tienen asientos con esas
 * etiquetas. Para corregir un croquis, crea un `code` nuevo (p. ej. `SPRINTER_20_V2`) y marca el
 * anterior con `isActive: false`.
 *
 * Convenciones del croquis: fila 0 = frente del vehículo; el operador va en la fila 0, columna 0
 * (lado izquierdo, como en México); "AISLE" = pasillo; null = vacío o celda cubierta por un WC.
 * Ninguna plantilla trae asientos de staff: el copiloto es un asiento de pasajero y cada agencia
 * bloquea en el croquis los asientos de su staff (`staffCapacity` del tour).
 */
export interface VehicleTemplateDefinition {
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
  layoutMap: LayoutMap;
}

const seat = (label: number | string): LayoutCell => ({
  type: "SEAT",
  label: String(label),
  kind: "PASSENGER",
});
const DRIVER: LayoutCell = { type: "DRIVER" };
const AISLE: LayoutCell = "AISLE";
const wc = (rowSpan = 1, colSpan = 1): LayoutCell => ({ type: "WC", rowSpan, colSpan });

/** Filas de autobús 2 + pasillo + 2, numeradas de izquierda a derecha: 1 2 | 3 4, 5 6 | 7 8 … */
const busRows = (rows: number, firstSeat = 1): LayoutCell[][] =>
  Array.from({ length: rows }, (_, i) => {
    const n = firstSeat + i * 4;
    return [seat(n), seat(n + 1), AISLE, seat(n + 2), seat(n + 3)];
  });

export const VEHICLE_TEMPLATE_CATALOG: VehicleTemplateDefinition[] = [
  {
    code: "SPRINTER_20",
    name: "Sprinter 20 lugares",
    description:
      "Van tipo Sprinter: cabina con operador y copiloto (asiento 1), 20 asientos de pasajero (1–20). Si la agencia lleva staff, lo bloquea en el croquis.",
    sortOrder: 10,
    isActive: true,
    layoutMap: [
      [DRIVER, null, null, seat(1)], // copiloto: asiento de pasajero
      [seat(2), seat(3), seat(4), null], // lado derecho libre: puerta corrediza
      [seat(5), seat(6), AISLE, seat(7)],
      [seat(8), seat(9), AISLE, seat(10)],
      [seat(11), seat(12), AISLE, seat(13)],
      [seat(14), seat(15), AISLE, seat(16)],
      [seat(17), seat(18), seat(19), seat(20)],
    ],
  },
  {
    code: "SPRINTER_14",
    name: "Sprinter 14 lugares",
    description:
      "Van tipo Sprinter: cabina con operador y copiloto (asiento 1), 14 asientos de pasajero (1–14). Si la agencia lleva staff, lo bloquea en el croquis.",
    sortOrder: 6,
    isActive: true,
    layoutMap: [
      [DRIVER, null, null, seat(1)], // copiloto: asiento de pasajero
      [seat(2), seat(3), AISLE, seat(4)],
      [seat(5), seat(6), AISLE, seat(7)],
      [seat(8), seat(9), AISLE, seat(10)],
      [seat(11), seat(12), seat(13), seat(14)], // banca trasera completa
    ],
  },
  {
    code: "SPRINTER_17",
    name: "Sprinter 17 lugares",
    description:
      "Van tipo Sprinter: cabina con operador y copiloto (asiento 1), 17 asientos de pasajero (1–17); acceso por la puerta corrediza del lado derecho. Si la agencia lleva staff, lo bloquea en el croquis.",
    sortOrder: 8,
    isActive: true,
    layoutMap: [
      [DRIVER, null, null, seat(1)], // copiloto: asiento de pasajero
      [seat(2), seat(3), seat(4), null], // lado derecho libre: puerta corrediza
      [seat(5), seat(6), AISLE, seat(7)],
      [seat(8), seat(9), AISLE, seat(10)],
      [seat(11), seat(12), AISLE, seat(13)],
      [seat(14), seat(15), seat(16), seat(17)], // banca trasera completa
    ],
  },
  {
    code: "BUS_48_WC",
    name: "Autobús 48 lugares (WC amplio)",
    description:
      "Autobús 2+2 con 48 asientos de pasajero; las dos últimas filas del lado derecho son el WC.",
    sortOrder: 20,
    isActive: true,
    layoutMap: [
      [DRIVER, null, AISLE, null, null],
      ...busRows(11), // 1–44
      [seat(45), seat(46), AISLE, wc(2, 2), null],
      [seat(47), seat(48), AISLE, null, null],
    ],
  },
  {
    code: "BUS_50_WC",
    name: "Autobús 50 lugares",
    description:
      "Autobús 2+2 con 50 asientos de pasajero; la última fila del lado derecho es el WC.",
    sortOrder: 30,
    isActive: true,
    layoutMap: [
      [DRIVER, null, AISLE, null, null],
      ...busRows(12), // 1–48
      [seat(49), seat(50), AISLE, wc(1, 2), null],
    ],
  },
];
