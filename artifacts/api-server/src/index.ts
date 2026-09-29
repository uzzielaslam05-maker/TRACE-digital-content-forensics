import app from "./app";
import { logger } from "./lib/logger";
import { warmUpModels } from "./services/ai-detector";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Fire-and-forget: don't block the health check on this. If it fails,
  // the affected model just stays "unavailable" until it's retried on the
  // first real request, same as before this warm-up existed.
  const warmUpStartedAt = performance.now();
  warmUpModels()
    .then(() => {
      logger.info({ durationMs: Math.round(performance.now() - warmUpStartedAt) }, "AI models warmed up");
    })
    .catch((err) => {
      logger.warn({ err }, "AI model warm-up failed; models will load lazily on first use instead");
    });
});
