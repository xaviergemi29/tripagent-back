import z from "zod";

export const loginBodySchema = z.object({
  email: z.email("Correo electrónico inválido").trim(),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
});

export const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1, "La contraseña actual es requerida"),
    newPassword: z.string().min(6, "La nueva contraseña debe tener al menos 6 caracteres"),
    confirmPassword: z.string().min(6, "Confirma la nueva contraseña"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "La nueva contraseña no puede ser igual a la actual",
    path: ["newPassword"],
  });

export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
