import { PrismaClient, Prisma } from '@prisma/client';

/**
 * True if the SubCategory exists. Lets master-data create paths surface a typed
 * SUBCATEGORY_NOT_FOUND instead of an opaque foreign-key error.
 */
export async function subCategoryExists(
  client: PrismaClient | Prisma.TransactionClient,
  subCategoryId: string
): Promise<boolean> {
  const sc = await client.subCategory.findUnique({
    where: { id: subCategoryId },
    select: { id: true },
  });
  return !!sc;
}
