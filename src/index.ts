import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

/**
 * Process entrypoint.
 *
 * Two things matter here beyond starting the server: configuration is
 * validated before anything binds a port, and shutdown drains in-flight
 * requests. Without the drain, a rolling deploy cuts live synthesis calls
 * mid-response, which the caller sees as a truncated audio file rather than a
 * retryable error.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      "\nCopy .env.example to .env and set SARVAM_API_KEY, then start again.",
    );
    process.exit(1);
    return;
  }

  const { app } = await buildServer(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    // Bound the drain so a wedged upstream cannot block the deploy forever.
    const timer = setTimeout(() => {
      app.log.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 15_000);
    timer.unref();

    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on("unhandledRejection", (reason) => {
    app.log.error({ reason }, "unhandled promise rejection");
  });

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(
      {
        upstream: config.SARVAM_BASE_URL,
        ttsModel: config.DEFAULT_TTS_MODEL,
        sttModel: config.DEFAULT_STT_MODEL,
        cache: config.CACHE_ENABLED,
        auth: config.GATEWAY_AUTH_TOKEN ? "enabled" : "open",
      },
      "sarvam-bridge ready",
    );
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

void main();
