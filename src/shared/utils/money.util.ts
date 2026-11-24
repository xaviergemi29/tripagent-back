/**
 * ¿El número tiene a lo más `decimals` decimales? (tolerancia para la representación binaria:
 * 19.354 o 0.1 + 0.2 no fallan por ruido de coma flotante).
 */
export const hasAtMostDecimals = (value: number, decimals: number): boolean => {
  const scaled = value * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};

/**
 * Importe para mensajes al operador, con el mismo formato que `formatCurrency` del front:
 * `$1,500.00 MXN` (símbolo, miles con coma, dos decimales y la divisa al final).
 */
export const formatMoney = (amount: number | string, currency: string): string =>
  `$${(Number(amount) || 0).toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
