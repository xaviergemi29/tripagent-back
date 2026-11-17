/**
 * Importe para mensajes al operador, con el mismo formato que `formatCurrency` del front:
 * `$1,500.00 MXN` (símbolo, miles con coma, dos decimales y la divisa al final).
 */
export const formatMoney = (amount: number | string, currency: string): string =>
  `$${(Number(amount) || 0).toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
