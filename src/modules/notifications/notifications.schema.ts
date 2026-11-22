import z from "zod";

export const notificationParamsSchema = z.object({
  id: z.uuid("Notificación inválida"),
});

export type NotificationParams = z.infer<typeof notificationParamsSchema>;
