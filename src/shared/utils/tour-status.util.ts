/**
 * Calcula el estado temporal de un tour basado en su fecha de salida y el estado operativo.
 * Utiliza la zona horaria de México (America/Mexico_City) como ancla de la verdad.
 */
export const getTourTemporalStatus = (departureDate: string, isActive: boolean): string => {
  // Regla 1: Cancelación manual absoluta
  if (!isActive) return "CANCELADO";

  // Extraemos la fecha actual exacta en México (YYYY-MM-DD)
  const todayMX = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

  // Validamos que departureDate exista antes de operar
  if (!departureDate) return "PRÓXIMO";

  // Matemática de fechas segura tipada explícitamente
  const tourDate = new Date(`${departureDate}T12:00:00Z`);
  tourDate.setDate(tourDate.getDate() + 1); // +24 horas (1 día de tolerancia)

  // Aseguramos que el resultado no sea undefined usando un fallback o conversión segura
  const toleranceDate: string = tourDate.toISOString().split("T")[0] ?? departureDate;

  // Regla 2: Evaluaciones temporales
  if (todayMX < departureDate) return "PRÓXIMO";
  if (todayMX >= departureDate && todayMX <= toleranceDate) return "EN CURSO";
  return "FINALIZADO";
};
