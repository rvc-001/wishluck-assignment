import { scrapeProduct } from "./src/scraper/productScraper";
import { analyzeImage } from "./src/brain/imageBrain";
import { logger } from "./src/lib/logger";

async function runTest() {
  const testUrl = "https://www.myntra.com/casual-shoes/adidas-originals/adidas-originals-men-sl-72-sneakers/35209771/buy";
  
  logger.info(`Starting Test with URL: ${testUrl}`);

  // --- PHASE 1 ---
  logger.info("=== RUNNING PHASE 1: PRODUCT RESOLVER ===");
  const productData = await scrapeProduct(testUrl);
  
  if ("error" in productData) {
    logger.error({ error: productData.error }, "Phase 1 failed");
    process.exit(1);
  }

  logger.info("Phase 1 Result:");
  console.log(productData);

  if (!productData || !productData.imageUrl) {
    logger.error("Failed to get image URL from Phase 1. Aborting Phase 2.");
    process.exit(1);
  }

  // --- PHASE 2 ---
  logger.info("=== RUNNING PHASE 2: IMAGE BRAIN ===");
  logger.info(`Extracting attributes and embedding for image: ${productData.imageUrl}`);
  
  const brainData = await analyzeImage(productData.imageUrl);

  logger.info("Phase 2 Result (Vision Attributes):");
  console.log(brainData.attributes);
  
  logger.info(`Phase 2 Result (Embedding length): ${brainData.embedding.length} values`);
  
  logger.info("✅ Phase 1 and Phase 2 are working perfectly!");
  process.exit(0);
}

runTest().catch((err) => {
  logger.error({ err }, "Test failed");
  process.exit(1);
});
