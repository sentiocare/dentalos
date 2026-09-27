import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { CallSession, type VoiceDeps } from "./session";

/**
 * The voice service: an HTTP server whose only real job is accepting the telephony provider's media-stream
 * WebSocket (one per call) at /media?key=<secret>. The secret is the same token as the call-flow URLs.
 */
export interface VoiceServer {
  server: Server;
  sessions: Set<CallSession>;
  close(): Promise<void>;
}

export function createVoiceServer(deps: VoiceDeps): VoiceServer {
  const sessions = new Set<CallSession>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, activeCalls: sessions.size, ttsCache: deps.ttsCache.hits }));
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://voice");
    const params = Object.fromEntries(url.searchParams);
    const headers = req.headers as Record<string, string | undefined>;
    if (url.pathname !== "/media" || !deps.telephony.verifyFlowRequest({ params, headers })) {
      deps.logger.warn({ path: url.pathname }, "media stream refused");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const session = new CallSession(ws, deps);
      sessions.add(session);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) session.onMessage(data.toString());
      });
      ws.on("close", () => {
        sessions.delete(session);
        session.onClose();
      });
      ws.on("error", (err) => deps.logger.warn({ err }, "media stream error"));
    });
  });

  return {
    server,
    sessions,
    async close() {
      for (const client of wss.clients) client.close(1001, "shutting down");
      await Promise.all([...sessions].map((s) => s.finish()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
