import serverlessExpress from "@vendia/serverless-express";
import { app } from "./index";

let handlerCache: any;

function validateEnv() {
  const required = ["S3_BUCKET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn(`[lambda] Missing required env vars: ${missing.join(", ")}`);
  }
  if (!process.env.PROVIDERS) {
    console.warn("[lambda] No provider configured (set PROVIDERS env var)");
  }
  if (!process.env.ADMIN_API_KEY) {
    console.warn("[lambda] ADMIN_API_KEY not set — admin endpoints disabled");
  }
}

export const handler = async (event: any, context: any, callback: any) => {
  if (!handlerCache) {
    validateEnv();
    handlerCache = serverlessExpress({ app });
  }
  return handlerCache(event, context, callback);
};
