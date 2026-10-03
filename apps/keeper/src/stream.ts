/**
 * The oracle's candidate stream — the keeper's ONLY tick source. Primary:
 * the WebSocket `/v1/stream`; when the socket stays down past
 * `sseFallbackSec`, the SSE fallback (`/v1/stream/sse`) takes over, and WS
 * preempts it again on reconnect. Double-processing across a handover is
 * harmless by construction: every candidate evaluates to work items whose
 * sim either reverts (skip) or executes idempotently against engine checks.
 */
import { WebSocket } from "ws";
import type { Logger } from "@gusd/types";
import type { CandidateTick } from "./strategy.js";

export interface StreamHandle {
  stop(): void;
}

function parseCandidate(raw: string): CandidateTick | null {
  try {
    const msg = JSON.parse(raw) as { type?: string; candidate?: CandidateTick };
    if (msg.type !== "candidate" || !msg.candidate) return null;
    const c = msg.candidate;
    if (typeof c.gpuId !== "string") return null;
    return {
      gpuId: c.gpuId,
      price: typeof c.price === "number" ? c.price : null,
      status: String(c.status ?? ""),
      calcHash: String(c.calcHash ?? ""),
    };
  } catch {
    return null;
  }
}

function connectWs(url: string, onTick: (t: CandidateTick) => void, logger: Logger): WebSocket {
  const ws = new WebSocket(url);
  ws.on("open", () => logger.info("oracle WS connected", { url }));
  ws.on("message", (data: WebSocket.RawData) => {
    const tick = parseCandidate(data.toString());
    if (tick) onTick(tick);
  });
  return ws;
}

/** SSE reader: fetch + stream parse of `event: candidate\ndata: {...}` frames. */
async function sseLoop(
  httpUrl: string,
  onTick: (t: CandidateTick) => void,
  logger: Logger,
  stopSignal: { stopped: boolean },
): Promise<void> {
  while (!stopSignal.stopped) {
    try {
      const res = await fetch(`${httpUrl}/v1/stream/sse`, { headers: { accept: "text/event-stream" } });
      if (!res.body) throw new Error(`no body (status ${res.status})`);
      logger.info("oracle SSE fallback connected", { httpUrl });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopSignal.stopped) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const tick = parseCandidate(dataLine.slice(6));
          if (tick) onTick(tick);
        }
      }
    } catch (err) {
      if (!stopSignal.stopped) logger.warn("SSE fallback failed — retrying", { err: String(err) });
    }
    if (!stopSignal.stopped) await sleep(2_000);
  }
}

export function connectCandidates(
  env: { oracleWsUrl: string; oracleHttpUrl: string; sseFallbackSec: number },
  logger: Logger,
  onTick: (tick: CandidateTick) => void,
): StreamHandle {
  const stopSignal = { stopped: false };
  let ws: WebSocket | null = null;
  let sseActive = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let downSince = 0;
  let backoffMs = 1_000;

  const open = (): void => {
    if (stopSignal.stopped) return;
    try {
      ws = connectWs(env.oracleWsUrl, onTick, logger);
    } catch (err) {
      logger.warn("WS construction failed", { err: String(err) });
      scheduleReconnect();
      return;
    }
    ws.on("open", () => {
      backoffMs = 1_000;
      downSince = 0;
      if (sseActive) {
        sseActive = false;
        logger.info("WS reconnected — SSE fallback retired");
      }
    });
    ws.on("close", () => {
      if (stopSignal.stopped) return;
      if (downSince === 0) downSince = Date.now();
      scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      logger.warn("oracle WS error", { err: String(err) });
    });
  };

  const scheduleReconnect = (): void => {
    if (stopSignal.stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // WS down past the fallback threshold → let SSE carry ticks until the
      // socket is back (open() retires it).
      if (!sseActive && downSince > 0 && Date.now() - downSince > env.sseFallbackSec * 1_000) {
        sseActive = true;
        logger.info("WS down past the fallback threshold — switching to SSE", {
          sseFallbackSec: env.sseFallbackSec,
        });
        void sseLoop(env.oracleHttpUrl, onTick, logger, stopSignal);
      }
      backoffMs = Math.min(backoffMs * 2, 30_000);
      open();
    }, backoffMs);
  };

  open();

  return {
    stop(): void {
      stopSignal.stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}