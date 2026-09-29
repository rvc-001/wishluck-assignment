import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "./src/lib/env";

async function run() {
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY!);
  // The SDK doesn't expose listModels directly easily, but we can hit the REST API directly
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`);
  const data: any = await response.json();
  console.log(data.models.map((m: any) => m.name));
}

run().catch(console.error);
