/**
 * Errores de negocio tipados. El manejador global de `app.ts` (`setErrorHandler`) los traduce a
 * HTTP con `instanceof`: NotFound → 404, BusinessRule → 400, Conflict → 409. Nunca compares el texto
 * del mensaje para decidir el código.
 */

/** El recurso no existe o no pertenece a la agencia de la sesión → 404. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Regla de negocio violada por los datos recibidos → 400. */
export class BusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessRuleError";
  }
}

/** La operación choca con el estado actual del recurso → 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** No hay lugares vendibles suficientes en el tour → 409. */
export class CapacityExceededError extends ConflictError {
  constructor(public readonly availableSeats: number) {
    super(`Capacidad excedida. Solo quedan ${Math.max(0, availableSeats)} lugares disponibles.`);
    this.name = "CapacityExceededError";
  }
}
