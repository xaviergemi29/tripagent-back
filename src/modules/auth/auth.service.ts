import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { ChangePasswordBody, LoginBody } from "./auth.schema.js";
import { agencyUsers } from "../../db/schema.js";
import bcrypt from "bcryptjs";
import { BusinessRuleError, NotFoundError } from "../../shared/errors/domain-errors.js";

/** Mensaje único para correo inexistente, usuario inactivo o contraseña incorrecta. */
export const INVALID_CREDENTIALS_MESSAGE = "Credenciales inválidas";

/**
 * Hash bcrypt (costo 12, igual que los reales) de un valor aleatorio que nadie conoce. Si el correo
 * no existe se compara contra él, para que la respuesta tarde lo mismo que con un correo válido y
 * el tiempo no revele qué correos están registrados.
 */
const DUMMY_PASSWORD_HASH = "$2b$12$rqmve/ixJqL.zNShM7WJs.Xtz08N/a4.KjwuXAop/HH9CuCFXCHe6";

/** Respuesta 401 cuando la sesión es válida pero el usuario ya no está activo. */
export const INACTIVE_USER_MESSAGE =
  "Tu usuario fue desactivado. Contacta al administrador de tu agencia.";

export class AuthService {
  /**
   * Sesión revocable (decisión del PM, 2026-11-14): el JWT dura 24 h, pero en cada petición
   * autenticada se confirma que el usuario siga activo y pertenezca a la agencia del token. Si el
   * admin lo desactiva a las 11:00, a las 11:01 sus peticiones responden 401.
   */
  static async isSessionActive(userId: string, agencyId: string): Promise<boolean> {
    const user = await db.query.agencyUsers.findFirst({
      where: and(eq(agencyUsers.id, userId), eq(agencyUsers.agencyId, agencyId)),
      columns: { isActive: true },
    });
    return Boolean(user?.isActive);
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
    });

    // 2. Comparar la contraseña en texto plano con el hash guardado en la BD (o con el hash de
    //    relleno si el usuario no existe: mismo costo de tiempo en ambos casos).
    const isPasswordValid = await bcrypt.compare(
      data.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !isPasswordValid) {
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
