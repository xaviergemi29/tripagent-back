/**
 * Registro público del Magic Link (decisión del PM, 2026-11-14): cuando el viajero ya existe en la
 * agencia (mismo WhatsApp), el formulario **solo completa los campos vacíos** y respeta los que ya
 * tienen datos. Así ni un error de captura ni un bromista pueden sobrescribir el nombre, el correo o
 * las notas médicas que ya estaban en el CRM de la agencia.
 */

/** Campos del perfil que el formulario público puede completar. */
export interface TravelerProfileFields {
  fullName?: string | null | undefined;
  email?: string | null | undefined;
  emergencyContactName?: string | null | undefined;
  emergencyContactPhone?: string | null | undefined;
  medicalNotes?: string | null | undefined;
  birthDate?: string | null | undefined;
}

const PROFILE_KEYS = [
  "fullName",
  "email",
  "emergencyContactName",
  "emergencyContactPhone",
  "medicalNotes",
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
): Partial<Record<(typeof PROFILE_KEYS)[number], string>> {
  const patch: Partial<Record<(typeof PROFILE_KEYS)[number], string>> = {};
  for (const key of PROFILE_KEYS) {
    const next = incoming[key];
    if (isBlank(existing[key]) && !isBlank(next)) {
      patch[key] = (next as string).trim();
    }
  }
  return patch;
}
