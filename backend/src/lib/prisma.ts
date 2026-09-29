import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

let prismaInstance: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient();
    logger.info("Prisma client initialized");
  }
  return prismaInstance;
}
