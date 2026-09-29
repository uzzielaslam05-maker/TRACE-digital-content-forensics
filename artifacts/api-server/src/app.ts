import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the built frontend from the same process, so a single deployment
// target (e.g. one Docker container) can host both the site and the API,
// instead of requiring two separately-hosted services. This is optional:
// if the frontend hasn't been built (e.g. running the API alone in dev),
// the server still runs fine with just the API routes above.
//
// Path note: this file is bundled by esbuild into artifacts/api-server/dist,
// so __dirname at runtime is that dist folder -- two levels up is
// artifacts/, alongside the sibling artifacts/trace package.
const FRONTEND_DIST = path.join(__dirname, "..", "..", "trace", "dist", "public");

if (existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  // Plain middleware (no path pattern) rather than app.get("*", ...):
  // Express 5's stricter path-to-regexp rejects a bare "*" wildcard route,
  // and wildcard syntax has changed across versions -- this works the same
  // regardless of version.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(FRONTEND_DIST, "index.html"));
  });
  logger.info({ FRONTEND_DIST }, "Serving built frontend");
} else {
  logger.info({ FRONTEND_DIST }, "No built frontend found; serving API routes only");
}

export default app;
