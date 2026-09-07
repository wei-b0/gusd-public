/**
 * Ponder's built-in API surface. The indexer is deliberately API-minimal
 * (rev 2): all application reads go through the oracle Fastify's
 * /v1/protocol/* against the stable views schema — this file exists because
 * Ponder requires an API module to boot. It serves liveness only; /ready,
 * /status and /metrics are Ponder-native and stay on the private network.
 */
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.json({ ok: true, service: "gusd-indexer" }));

export default app;
