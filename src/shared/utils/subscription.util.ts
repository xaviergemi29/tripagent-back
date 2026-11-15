/**
 * Reglas puras de la suscripción de la agencia (pestaña "Suscripción" de Configuración).
 * Sin base de datos ni `process.env`: el servicio les pasa los datos y la configuración.
 */

const MX_TIME_ZONE = "America/Mexico_City";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Plan único del MVP: precio mensual (IVA incluido) y duración de la prueba gratuita. */
export const SUBSCRIPTION_PLAN = {
  priceMxn: 499,
  trialDaysTotal: 30,
} as const;

/** Fecha calendario `YYYY-MM-DD` de un instante en la hora de CDMX. */
export const toMexicoDate = (instant: Date): string =>
  instant.toLocaleDateString("en-CA", { timeZone: MX_TIME_ZONE });

/** Días calendario entre dos fechas `YYYY-MM-DD` (b − a). */
const diffCalendarDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Fin de la prueba. `agencies.trialEndsAt` puede ser nulo (el alta por CLI no lo llena): en ese caso
 * la prueba termina `trialDaysTotal` días después del alta de la agencia.
 */
export const resolveTrialEndsAt = (
  trialEndsAt: string | null | undefined,
  createdAt: string,
  trialDaysTotal: number = SUBSCRIPTION_PLAN.trialDaysTotal,
): string =>
  trialEndsAt
    ? new Date(trialEndsAt).toISOString()
    : new Date(Date.parse(createdAt) + trialDaysTotal * DAY_MS).toISOString();

/**
 * Consumo de la prueba en días calendario de CDMX. `remaining` cuenta hasta el día de vencimiento
 * (ese día ya no cuenta como restante) y `consumed = total − remaining`, acotado a [0, total].
 * `expired` es verdadero desde el instante de vencimiento.
 */
export const computeTrialProgress = (
  trialEndsAt: string,
  now: Date,
  trialDaysTotal: number = SUBSCRIPTION_PLAN.trialDaysTotal,
) => {
  const remainingRaw = diffCalendarDays(toMexicoDate(now), toMexicoDate(new Date(trialEndsAt)));
  const trialDaysRemaining = Math.min(trialDaysTotal, Math.max(0, remainingRaw));
  return {
    trialDaysTotal,
    trialDaysRemaining,
    trialDaysConsumed: trialDaysTotal - trialDaysRemaining,
    trialExpired: now.getTime() >= Date.parse(trialEndsAt),
  };
};

/**
 * Referencia del pago SPEI: primera palabra del nombre (sin acentos, solo letras, ≤ 6) + los últimos
 * 4 caracteres del id de la agencia. Es estable y permite identificar la transferencia.
 * Ej.: "Bruji Tours", id "…7492" → "BRUJI-7492".
 */
export const buildSpeiReference = (agencyName: string, agencyId: string): string => {
  const prefix =
    agencyName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .split(/\s+/)
      .map((word) => word.replace(/[^A-Z]/g, ""))
      .find((word) => word.length > 0)
      ?.slice(0, 6) || "AGENCIA";
  const suffix = agencyId.replace(/-/g, "").slice(-4).toUpperCase();
  return `${prefix}-${suffix}`;
};

type Env = Record<string, string | undefined>;

/** Datos de cobro de TripAgent (no de la agencia). Cada canal es `null` si no está configurado. */
export interface SubscriptionBillingConfig {
  spei: { bank: string; beneficiary: string; clabe: string } | null;
  stripePaymentLink: string | null;
  whatsappSupportNumber: string | null;
}

const clean = (value: string | undefined): string => value?.trim() ?? "";

/**
 * Lee la configuración de cobro de las variables `SUBSCRIPTION_*` (ver `.env.example`).
 * Un valor inválido se trata como ausente: el front oculta ese canal en lugar de mostrar datos rotos.
 */
export const resolveSubscriptionBillingConfig = (
  env: Env = process.env,
): SubscriptionBillingConfig => {
  const bank = clean(env.SUBSCRIPTION_SPEI_BANK);
  const beneficiary = clean(env.SUBSCRIPTION_SPEI_BENEFICIARY);
  const clabe = clean(env.SUBSCRIPTION_SPEI_CLABE).replace(/[\s-]/g, "");

  const stripeRaw = clean(env.SUBSCRIPTION_STRIPE_PAYMENT_LINK);
  let stripePaymentLink: string | null = null;
  try {
    if (stripeRaw && new URL(stripeRaw).protocol === "https:") stripePaymentLink = stripeRaw;
  } catch {
    stripePaymentLink = null;
  }

  const whatsapp = clean(env.SUBSCRIPTION_WHATSAPP_NUMBER).replace(/\D/g, "");

  return {
    spei: bank && beneficiary && /^\d{18}$/.test(clabe) ? { bank, beneficiary, clabe } : null,
    stripePaymentLink,
    whatsappSupportNumber: /^\d{10,15}$/.test(whatsapp) ? whatsapp : null,
  };
};
