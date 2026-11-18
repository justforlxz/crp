-- AlterTable
ALTER TABLE "package" ADD COLUMN     "current_commit" TEXT,
ADD COLUMN     "last_synced_at" TIMESTAMPTZ(3);
