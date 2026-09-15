import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { magicTokens } from "../../db/schema.js";

export class MagicTokenService {
    static async validate(tokenValue: string) {
        const magicToken = await db
        .query
        .magicTokens
        .findFirst({
            where: eq(magicTokens.token, tokenValue),
            with: { tour: true }
        });

        if (!magicToken) 
            return {
                error: { 
                    code: "NOT_FOUND" as const, 
                    message: "El enlace mágico no existe o es incorrecto." 
                } 
            };

        console.log("magicToken", magicToken)

        if (new Date() > new Date(magicToken.expiresAt)) {
            return { error: { code: "EXPIRED" as const, message: "Este enlace ha superado su tiempo de validez. Solicita uno nuevo." } };
        }

        if (magicToken.currentUses >= magicToken.maxUses) {
            return { error: { code: "CAPACITY_REACHED" as const, message: "Este enlace ya alcanzó su límite de registros permitidos." } };
        }
        

        // Si pasa todas las validaciones, devolvemos la metadata útil
        return {
            isValid: true,
            data: {
                tour: {
                    id: magicToken.tour.id,
                    title: magicToken.tour.title,
                    boardingPoints: magicToken.tour.boardingPoints
                },
                availableSeats: magicToken.maxUses - magicToken.currentUses
            }
        };
    }
}