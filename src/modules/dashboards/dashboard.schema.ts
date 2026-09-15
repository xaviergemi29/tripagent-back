import z from "zod"

export const GetDashboardParamsSchema = z.object({
    id: z.uuid(),    
});