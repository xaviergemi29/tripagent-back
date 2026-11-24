/**
 * Código de un error de base de datos o de Fastify (`23505` único, `23503` FK,
 * `FST_REQ_FILE_TOO_LARGE`…). Drizzle 0.45 envuelve el error del driver en `DrizzleQueryError` y
 * deja el original en `cause`: leer solo `error.code` convertía esos 409 en 500. Única definición:
 * toda comparación con un código de Postgres pasa por aquí.
 */
export const getErrorCode = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  const cause: unknown = error.cause;
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
};
