import pino from "pino";
import fs from "fs";
import path from "path";
import { env } from "./env";

const logsDir = path.resolve(__dirname, "../../logs");
fs.mkdirSync(logsDir, { recursive: true });

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "config.headers.Authorization",
      "err.config.headers.Authorization",
      "err.request._header",
      "APIFY_API_TOKEN",
    ],
    censor: "[redacted]",
  },
}, pino.multistream([
  { stream: pino.destination(1) },
  { stream: pino.destination(path.join(logsDir, "backend.log")) },
]));
