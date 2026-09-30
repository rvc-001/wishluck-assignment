ALTER TABLE "Video" ADD COLUMN "providerMediaId" TEXT;
ALTER TABLE "Video" ADD COLUMN "providerCreatorId" TEXT;
ALTER TABLE "Video" ADD COLUMN "creatorHandle" TEXT;
ALTER TABLE "Video" ADD COLUMN "contentType" TEXT DEFAULT 'unknown';
ALTER TABLE "Video" ADD COLUMN "sourceKind" TEXT DEFAULT 'unknown';
ALTER TABLE "Video" ADD COLUMN "isPaidPartnership" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Video" ADD COLUMN "paidMarkerDetected" TEXT;
ALTER TABLE "Video" ADD COLUMN "dropReason" TEXT;
