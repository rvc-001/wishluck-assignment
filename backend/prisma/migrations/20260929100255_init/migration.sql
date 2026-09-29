-- CreateTable
CREATE TABLE "Search" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "query" TEXT NOT NULL,
    "queryType" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',
    "thumbnailUrl" TEXT NOT NULL DEFAULT '',
    "caption" TEXT NOT NULL DEFAULT '',
    "urlHash" TEXT NOT NULL,
    "thumbPHash" TEXT NOT NULL DEFAULT '',
    "captionSimhash" TEXT NOT NULL DEFAULT '',
    "embedding" BLOB NOT NULL DEFAULT '',
    "metaPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SearchResult" (
    "searchId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "label" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("searchId", "videoId"),
    CONSTRAINT "SearchResult_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "Search" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SearchResult_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Video_urlHash_key" ON "Video"("urlHash");

-- CreateIndex
CREATE UNIQUE INDEX "Video_platform_platformId_key" ON "Video"("platform", "platformId");
