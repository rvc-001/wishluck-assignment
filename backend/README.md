# Backend - Product Video Discovery Dashboard

This directory contains the robust Express.js API and background processing workers that power the Video Discovery Dashboard. It acts as the orchestration layer between the user, the database, the VLMs, and the web scrapers.

## Tech Stack
- **Framework:** Express (Node.js) + TypeScript
- **Database:** Prisma ORM with SQLite
- **Queue System:** BullMQ (backed by Redis) with an inline-fallback mode
- **VLMs:** Google Gen AI (Gemini 3.5 Flash)
- **Scrapers:** Apify actors + official Meta APIs

## Project Structure
- `src/index.ts` - Main entry point, health checks, and API route bootstrapping.
- `src/brain/` - Image attribute extraction and search embedding proxies.
- `src/collectors/` - Integrations for Apify (Instagram) and Meta Ad Library APIs.
- `src/dedup/` - Extensive multi-layer deduplication logic (pHash, SimHash, CLIP).
- `src/jobs/` - BullMQ workers and progress event emitters (SSE).
- `prisma/` - SQLite database schema and migrations.

## Local Development

1. Ensure you have a `.env` file in the project root with your API keys.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Generate Prisma client and push the schema to create your local SQLite database:
   ```bash
   npx prisma generate
   npx prisma db push
   ```
4. Start the API server:
   ```bash
   npm run dev
   ```
   *The backend will be available at `http://localhost:3001`.*

## Health Check
You can verify the backend is running and check its Redis connection status via the health check endpoint:
```bash
GET /health
```
