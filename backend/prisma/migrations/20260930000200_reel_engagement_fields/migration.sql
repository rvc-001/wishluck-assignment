UPDATE "Video"
SET "contentType" = 'reel'
WHERE "platform" = 'instagram'
  AND ("contentType" IS NULL OR "contentType" = 'unknown')
  AND "url" LIKE '%/reel/%';

ALTER TABLE "Video" ADD COLUMN "views" INTEGER;
ALTER TABLE "Video" ADD COLUMN "likes" INTEGER;
ALTER TABLE "Video" ADD COLUMN "engagementFetchedAt" DATETIME;
