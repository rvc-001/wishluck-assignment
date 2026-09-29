# Frontend - Product Video Discovery Dashboard

This directory contains the React + Vite frontend for the Product Video Discovery Dashboard. It provides a clean, responsive, and dynamic user interface to search for and review curated product videos.

## Tech Stack
- **Framework:** React 18
- **Build Tool:** Vite
- **Styling:** TailwindCSS
- **State Management:** React hooks + internal Context (where applicable)
- **Deployment Ready:** Configured for seamless deployment on Vercel (`vercel.json` included for API proxying).

## Project Structure
- `src/` - Contains all React components, hooks, and API integrations.
- `public/` - Static assets like the favicon and SVGs.
- `vercel.json` - Vercel edge configuration to proxy `/api` calls directly to the Render backend, bypassing CORS issues.

## Local Development

1. Ensure the backend is running locally on port `3001`.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
4. The dashboard will be available at `http://localhost:5173`. 
*(Note: Vite automatically proxies `/api` calls to `http://localhost:3001` during local development via `vite.config.ts`).*
