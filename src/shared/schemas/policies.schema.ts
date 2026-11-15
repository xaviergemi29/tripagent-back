import { z } from "zod";

/**
 * Límite de caracteres de un bloque de políticas (agencia o tour). El estado de cuenta PDF las
 * imprime completas en varias páginas si hace falta; el límite evita documentos desmedidos.
 * Espejo en el front: `POLICIES_MAX_LENGTH` en `tripagent-front/src/shared/constants/domain.constants.ts`.
 */
export const POLICIES_MAX_LENGTH = 5000;

/** Texto libre de políticas: se recorta; vacío o solo espacios → `null` (sin políticas). */
export const policiesTextSchema = z.preprocess(
  (val) => (typeof val === "string" && val.trim() === "" ? null : val),
  z
    .string()
    .trim()
    .max(POLICIES_MAX_LENGTH, `Las políticas no pueden superar ${POLICIES_MAX_LENGTH} caracteres`)
    .nullable(),
);
