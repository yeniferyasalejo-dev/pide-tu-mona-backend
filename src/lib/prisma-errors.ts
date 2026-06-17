import { Prisma } from "@prisma/client";

/** P2021: tabla no existe (migración pendiente). */
export function isPrismaMissingTableError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2021"
  );
}

export function getPrismaMissingTableName(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2021") {
    return undefined;
  }
  const meta = error.meta as { table?: string; modelName?: string } | undefined;
  return meta?.table ?? meta?.modelName;
}
