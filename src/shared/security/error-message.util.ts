/**
 * Mensaje de los 500. El manejador global (`app.ts`) responde SIEMPRE este texto a un error que no
 * sea de dominio (NotFound/BusinessRule/Conflict): un error de Drizzle trae "Failed query: <SQL>
 * params: <valores>" y el driver expone tablas, columnas y datos personales; cualquier otro error
 * interno tampoco se muestra. El detalle queda en el log.
 *
 * (2026-11-15: se eliminó `toClientErrorMessage`, que dejaba pasar el texto de cualquier `Error` que
 * no pareciera de base de datos. Los mensajes de negocio viajan solo en errores de dominio.)
 */
export const GENERIC_ERROR_MESSAGE = "Error interno del servidor";
