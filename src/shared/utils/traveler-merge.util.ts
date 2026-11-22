/**
 * Registro público del Magic Link (decisión del PM, 2026-11-14): cuando el viajero ya existe en la
 * agencia (mismo WhatsApp), el formulario **solo completa los campos vacíos** y respeta los que ya
 * tienen datos. Así ni un error de captura ni un bromista pueden sobrescribir el nombre, el correo o
 * el contacto de emergencia que ya estaban en el CRM de la agencia.
 */

/** Campos del perfil que el formulario público puede completar. */
export interface TravelerProfileFields {
  fullName?: string | null | undefined;
  email?: string | null | undefined;
  emergencyContactName?: string | null | undefined;
  emergencyContactPhone?: string | null | undefined;
  emergencyContactCountry?: string | null | undefined;
  birthDate?: string | null | undefined;
}

const PROFILE_KEYS = [
  "fullName",
  "email",
  "emergencyContactName",
  "emergencyContactPhone",
  "birthDate",
] as const satisfies readonly (keyof TravelerProfileFields)[];

/** Vacío = nulo, cadena en blanco o el marcador "N/A" que se guarda como correo de un menor. */
const isBlank = (value: string | null | undefined): boolean => {
  const text = (value ?? "").trim();
  return text === "" || text.toUpperCase() === "N/A";
};

/**
 * Devuelve solo los campos que se deben escribir: los que están vacíos en el perfil existente y
 * llegan con valor en el formulario. Un objeto vacío significa "no actualizar nada".
 */
export function fillEmptyTravelerFields(
  existing: TravelerProfileFields,
  incoming: TravelerProfileFields,
): Partial<Record<(typeof PROFILE_KEYS)[number] | "emergencyContactCountry", string>> {
  const patch: Partial<Record<(typeof PROFILE_KEYS)[number] | "emergencyContactCountry", string>> =
    {};
  for (const key of PROFILE_KEYS) {
    const next = incoming[key];
    if (isBlank(existing[key]) && !isBlank(next)) {
      patch[key] = (next as string).trim();
    }
  }
  // El país del teléfono de emergencia acompaña a su número: solo se escribe si el número se completó.
  if (patch.emergencyContactPhone && incoming.emergencyContactCountry) {
    patch.emergencyContactCountry = incoming.emergencyContactCountry;
  }
  return patch;
}

/**
 * Confirma la lada de un WhatsApp anterior al selector de país (2026-11-16): si el viajero
 * encontrado no tiene país (`whatsappCountry` nulo = lada inferida) y quien captura sí lo eligió,
 * se guardan el país y el número en E.164. Es el **mismo número** (la búsqueda ya lo comparó), así
 * que no cambia la identidad del viajero; un país ya confirmado nunca se sobrescribe.
 */
export function confirmLegacyPhone(
  existing: { whatsappCountry?: string | null | undefined },
  incoming: {
    whatsappPhone?: string | null | undefined;
    whatsappCountry?: string | null | undefined;
  },
): { whatsappPhone?: string; whatsappCountry?: string } {
  if (existing.whatsappCountry || !incoming.whatsappCountry || !incoming.whatsappPhone) return {};
  return { whatsappPhone: incoming.whatsappPhone, whatsappCountry: incoming.whatsappCountry };
}
