import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { ChangePasswordBody, LoginBody, RegisterAgencyBody } from "./auth.schema.js";
import { agencies, agencyUsers } from "../../db/schema.js";
import bcrypt from "bcryptjs";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "../../shared/errors/domain-errors.js";
import { SUBSCRIPTION_PLAN } from "../../shared/utils/subscription.util.js";

/** Mensaje único para correo inexistente, usuario inactivo o contraseña incorrecta. */
export const INVALID_CREDENTIALS_MESSAGE = "Credenciales inválidas";

/**
 * Hash bcrypt (costo 12, igual que los reales) de un valor aleatorio que nadie conoce. Si el correo
 * no existe se compara contra él, para que la respuesta tarde lo mismo que con un correo válido y
 * el tiempo no revele qué correos están registrados.
 */
const DUMMY_PASSWORD_HASH = "$2b$12$rqmve/ixJqL.zNShM7WJs.Xtz08N/a4.KjwuXAop/HH9CuCFXCHe6";

/** 409 del registro de agencia con un correo que ya tiene usuario. */
export const EMAIL_ALREADY_REGISTERED_MESSAGE = "Este correo ya está registrado. Inicia sesión.";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Respuesta 401 cuando la sesión es válida pero el usuario ya no está activo. */
export const INACTIVE_USER_MESSAGE =
  "Tu usuario fue desactivado. Contacta al administrador de tu agencia.";

/**
 * La agencia sigue habilitada: `agencies.isActive` y sin borrado lógico. Es el bloqueo total por
 * impago (feedback del PM, 2026-11-18): TripAgent pone `isActive = false` tras 15 días de prueba
 * vencida o pago pendiente y todos sus usuarios pierden el acceso (401). Hasta entonces la agencia
 * solo queda en Modo Solo Lectura. Falla cerrado: sin la fila de la agencia no hay acceso.
 */
const isAgencyEnabled = (
  agency: { isActive: boolean; deletedAt: string | null } | null | undefined,
) => Boolean(agency?.isActive && !agency.deletedAt);

export class AuthService {
  /**
   * Sesión revocable (decisión del PM, 2026-11-14): el JWT dura 24 h, pero en cada petición
   * autenticada se confirma que el usuario siga activo y pertenezca a la agencia del token. Si el
   * admin lo desactiva a las 11:00, a las 11:01 sus peticiones responden 401. Desde el 2026-11-18
   * también se corta si la agencia está desactivada o borrada (bloqueo total por impago).
   */
  static async isSessionActive(userId: string, agencyId: string): Promise<boolean> {
    const user = await db.query.agencyUsers.findFirst({
      where: and(eq(agencyUsers.id, userId), eq(agencyUsers.agencyId, agencyId)),
      columns: { isActive: true },
      with: { agency: { columns: { isActive: true, deletedAt: true } } },
    });
    return Boolean(user?.isActive) && isAgencyEnabled(user?.agency);
  }

  static async authenticate(data: LoginBody) {
    // 1. Buscar al usuario por correo electrónico
    const user = await db.query.agencyUsers.findFirst({
      where: and(eq(agencyUsers.email, data.email), eq(agencyUsers.isActive, true)),
      columns: {
        id: true,
        agencyId: true,
        email: true,
        fullName: true,
        role: true,
        passwordHash: true,
      },
      with: { agency: { columns: { isActive: true, deletedAt: true } } },
    });

    // 2. Comparar la contraseña en texto plano con el hash guardado en la BD (o con el hash de
    //    relleno si el usuario no existe: mismo costo de tiempo en ambos casos).
    const isPasswordValid = await bcrypt.compare(
      data.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    // Agencia desactivada (bloqueo total por impago): mismo mensaje que unas credenciales inválidas.
    if (!user || !isPasswordValid || !isAgencyEnabled(user.agency)) {
      throw new Error(INVALID_CREDENTIALS_MESSAGE);
    }

    return {
      id: user.id,
      agencyId: user.agencyId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    };
  }

  /**
   * Alta de agencia desde la web (/registro, 2026-11-22). En una transacción: agencia en prueba
   * (`trialing`, `trialEndsAt` = ahora + 30 días) y su usuario ADMIN con la contraseña hasheada
   * (bcrypt 12). El correo de acceso es único entre todos los usuarios (409 si ya existe). Devuelve
   * el usuario con la forma del login, para abrir la sesión sin verificar el correo.
   */
  static async registerAgency(data: RegisterAgencyBody) {
    const existingUser = await db.query.agencyUsers.findFirst({
      where: eq(agencyUsers.email, data.email),
      columns: { id: true },
    });
    if (existingUser) throw new ConflictError(EMAIL_ALREADY_REGISTERED_MESSAGE);

    const passwordHash = await bcrypt.hash(data.password, 12);
    const trialEndsAt = new Date(Date.now() + SUBSCRIPTION_PLAN.trialDaysTotal * DAY_MS);

    try {
      return await db.transaction(async (tx) => {
        const [agency] = await tx
          .insert(agencies)
          .values({
            name: data.agencyName,
            email: data.email,
            phone: data.whatsapp,
            phoneCountry: data.whatsappCountry ?? null,
            subscriptionStatus: "trialing",
            trialEndsAt: trialEndsAt.toISOString(),
            isActive: true,
          })
          .returning({ id: agencies.id });
        if (!agency) throw new Error("No se pudo crear la agencia");

        const [user] = await tx
          .insert(agencyUsers)
          .values({
            agencyId: agency.id,
            email: data.email,
            passwordHash,
            fullName: data.fullName,
            role: "ADMIN",
            isActive: true,
          })
          .returning({
            id: agencyUsers.id,
            agencyId: agencyUsers.agencyId,
            email: agencyUsers.email,
            fullName: agencyUsers.fullName,
            role: agencyUsers.role,
          });
        if (!user) throw new Error("No se pudo crear el usuario administrador");

        return user;
      });
    } catch (error) {
      // Dos registros simultáneos con el mismo correo: el índice único de agency_users decide.
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictError(EMAIL_ALREADY_REGISTERED_MESSAGE);
      }
      throw error;
    }
  }

  static async getUserProfile(userId: string) {
    const user = await db.query.agencyUsers.findFirst({
      where: and(eq(agencyUsers.id, userId), eq(agencyUsers.isActive, true)),
      with: {
        agency: {
          columns: {
            name: true, // Traemos el nombre real de la agencia
            logoPath: true, // Logotipo para el Sidebar
          },
        },
      },
      columns: {
        id: true,
        agencyId: true,
        email: true,
        fullName: true,
        role: true,
      },
    });

    if (!user) {
      throw new NotFoundError("Usuario no encontrado");
    }

    // Aplanamos ligeramente la respuesta para el DTO del Front-End
    return {
      id: user.id,
      agencyId: user.agencyId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      agencyName: user.agency?.name || "Brujitours", // Fallback seguro
      // Ruta del logotipo (`/uploads/logos/…`) o null; el front la sirve desde <origen API>/public.
      agencyLogoPath: user.agency?.logoPath ?? null,
    };
  }

  static async changePassword(userId: string, data: ChangePasswordBody) {
    const user = await db.query.agencyUsers.findFirst({
      where: and(eq(agencyUsers.id, userId), eq(agencyUsers.isActive, true)),
      columns: { id: true, passwordHash: true },
    });

    if (!user) throw new NotFoundError("Usuario no encontrado");

    // 1. Validar que la contraseña actual ingresada es correcta
    const isCurrentValid = await bcrypt.compare(data.currentPassword, user.passwordHash);
    if (!isCurrentValid) {
      throw new BusinessRuleError("La contraseña actual es incorrecta");
    }
    // 2. Generar el nuevo hash (Factor 12)
    const salt = await bcrypt.genSalt(12);
    const newPasswordHash = await bcrypt.hash(data.newPassword, salt);

    // 3. Persistir el cambio
    await db
      .update(agencyUsers)
      .set({
        passwordHash: newPasswordHash,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agencyUsers.id, userId));

    return true;
  }
}
