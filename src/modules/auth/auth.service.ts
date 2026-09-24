import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { ChangePasswordBody, LoginBody } from "./auth.schema.js";
import { agencyUsers } from "../../db/schema.js";
import bcrypt from "bcryptjs";

export class AuthService {
  static async authenticate(data: LoginBody) {
    // 1. Buscar al usuario por correo electrónico
    const user = await db.query.agencyUsers.findFirst({
      where: and(eq(agencyUsers.email, data.email), eq(agencyUsers.isActive, true)),
    });

    if (!user) throw new Error("Credenciales inválidas");

    // 2. Comparar la contraseña en texto plano con el hash guardado en la BD
    const isPasswordValid = await bcrypt.compare(data.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new Error("Credenciales inválidas");
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
      throw new Error("Usuario no encontrado");
    }

    // Aplanamos ligeramente la respuesta para el DTO del Front-End
    return {
      id: user.id,
      agencyId: user.agencyId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      agencyName: user.agency?.name || "Brujitours", // Fallback seguro
    };
  }

  static async changePassword(userId: string, data: ChangePasswordBody) {
    const user = await db.query.agencyUsers.findFirst({
      where: and(eq(agencyUsers.id, userId), eq(agencyUsers.isActive, true)),
    });

    if (!user) throw new Error("Usuario no encontrado");

    // 1. Validar que la contraseña actual ingresada es correcta
    const isCurrentValid = await bcrypt.compare(data.currentPassword, user.passwordHash);
    if (!isCurrentValid) {
      throw new Error("La contraseña actual es incorrecta");
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
