import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agencies, agencyBankAccounts } from "../../db/schema.js";
import { AGENCY_BANK_ACCOUNTS_MAX } from "../../shared/constants/domain.constants.js";
import { ConflictError, NotFoundError } from "../../shared/errors/domain-errors.js";
import type { CreateBankAccountBody, UpdateBankAccountBody } from "./agency.schema.js";
import { getErrorCode } from "../../shared/utils/db-error.util.js";

const DUPLICATE_CLABE = "Ya registraste una cuenta con esa CLABE";
const ACCOUNT_NOT_FOUND = "Cuenta bancaria no encontrada";

/**
 * Cuentas bancarias de la agencia de la sesión (hasta `AGENCY_BANK_ACCOUNTS_MAX`). `position` es el
 * orden de alta: la primera es la "principal" solo por orden; un borrado deja huecos y las nuevas
 * siguen desde la mayor. Borrado físico.
 */
export class AgencyBankAccountService {
  static async listAccounts(agencyId: string) {
    return db.query.agencyBankAccounts.findMany({
      where: eq(agencyBankAccounts.agencyId, agencyId),
      columns: {
        id: true,
        bankName: true,
        accountHolder: true,
        clabeNumber: true,
        cardNumber: true,
        position: true,
      },
      orderBy: [asc(agencyBankAccounts.position), asc(agencyBankAccounts.id)],
    });
  }

  /**
   * Alta con la fila de la agencia bloqueada (`FOR UPDATE`): dos altas simultáneas no superan el
   * límite ni repiten `position`. 409 por CLABE repetida o por límite.
   */
  static async createAccount(agencyId: string, userId: string, body: CreateBankAccountBody) {
    try {
      return await db.transaction(async (tx) => {
        const [agency] = await tx
          .select({ id: agencies.id })
          .from(agencies)
          .where(eq(agencies.id, agencyId))
          .for("update");
        if (!agency) throw new NotFoundError("Agencia no encontrada");

        const existing = await tx
          .select({
            clabeNumber: agencyBankAccounts.clabeNumber,
            position: agencyBankAccounts.position,
          })
          .from(agencyBankAccounts)
          .where(eq(agencyBankAccounts.agencyId, agencyId));

        if (existing.some((account) => account.clabeNumber === body.clabeNumber)) {
          throw new ConflictError(DUPLICATE_CLABE);
        }
        if (existing.length >= AGENCY_BANK_ACCOUNTS_MAX) {
          throw new ConflictError(
            `Puedes registrar hasta ${AGENCY_BANK_ACCOUNTS_MAX} cuentas bancarias`,
          );
        }

        const [created] = await tx
          .insert(agencyBankAccounts)
          .values({
            agencyId,
            bankName: body.bankName,
            accountHolder: body.accountHolder,
            clabeNumber: body.clabeNumber,
            cardNumber: body.cardNumber ?? null,
            position: Math.max(0, ...existing.map((account) => account.position)) + 1,
            createdByUserId: userId,
            updatedByUserId: userId,
          })
          .returning({
            id: agencyBankAccounts.id,
            bankName: agencyBankAccounts.bankName,
            accountHolder: agencyBankAccounts.accountHolder,
            clabeNumber: agencyBankAccounts.clabeNumber,
            cardNumber: agencyBankAccounts.cardNumber,
            position: agencyBankAccounts.position,
          });
        if (!created) throw new Error("No se pudo registrar la cuenta bancaria");
        return created;
      });
    } catch (error) {
      if (getErrorCode(error) === "23505") throw new ConflictError(DUPLICATE_CLABE);
      throw error;
    }
  }

  /** Edición parcial: solo se escriben los campos enviados. 404 si la cuenta no es de la agencia. */
  static async updateAccount(
    agencyId: string,
    userId: string,
    accountId: string,
    body: UpdateBankAccountBody,
  ) {
    if (body.clabeNumber !== undefined) {
      const sameAgencyAccounts = await db
        .select({ id: agencyBankAccounts.id, clabeNumber: agencyBankAccounts.clabeNumber })
        .from(agencyBankAccounts)
        .where(eq(agencyBankAccounts.agencyId, agencyId));
      const duplicate = sameAgencyAccounts.some(
        (account) => account.id !== accountId && account.clabeNumber === body.clabeNumber,
      );
      if (duplicate) throw new ConflictError(DUPLICATE_CLABE);
    }

    try {
      const [updated] = await db
        .update(agencyBankAccounts)
        .set({
          ...(body.bankName !== undefined && { bankName: body.bankName }),
          ...(body.accountHolder !== undefined && { accountHolder: body.accountHolder }),
          ...(body.clabeNumber !== undefined && { clabeNumber: body.clabeNumber }),
          ...(body.cardNumber !== undefined && { cardNumber: body.cardNumber }),
          updatedByUserId: userId,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(agencyBankAccounts.id, accountId), eq(agencyBankAccounts.agencyId, agencyId)))
        .returning({
          id: agencyBankAccounts.id,
          bankName: agencyBankAccounts.bankName,
          accountHolder: agencyBankAccounts.accountHolder,
          clabeNumber: agencyBankAccounts.clabeNumber,
          cardNumber: agencyBankAccounts.cardNumber,
          position: agencyBankAccounts.position,
        });
      if (!updated) throw new NotFoundError(ACCOUNT_NOT_FOUND);
      return updated;
    } catch (error) {
      // Dos ediciones simultáneas con la misma CLABE: lo detiene el índice único.
      if (getErrorCode(error) === "23505") throw new ConflictError(DUPLICATE_CLABE);
      throw error;
    }
  }

  /** Borrado físico. Se permite borrar la última cuenta (regla 22). Las demás no se renumeran. */
  static async deleteAccount(agencyId: string, accountId: string) {
    const [deleted] = await db
      .delete(agencyBankAccounts)
      .where(and(eq(agencyBankAccounts.id, accountId), eq(agencyBankAccounts.agencyId, agencyId)))
      .returning({ id: agencyBankAccounts.id });
    if (!deleted) throw new NotFoundError(ACCOUNT_NOT_FOUND);
    return deleted;
  }
}
