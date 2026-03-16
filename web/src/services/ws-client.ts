import type { WsResponse } from "../types";

export type WsMessageHandler = (response: WsResponse) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private pairingCode: string;
  private handler: WsMessageHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;

  constructor(url: string, pairingCode: string, handler: WsMessageHandler) {
    this.url = url;
    this.pairingCode = pairingCode;
    this.handler = handler;
  }

  connect() {
    this.shouldReconnect = true;
    this.reconnectDelay = 1000;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
      };

      this.ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data as string) as WsResponse;

          // Auto-authenticate when we receive the welcome message
          if (response.type === "connected") {
            this.send({ type: "authenticate", pairing_code: this.pairingCode });
          }

          this.handler(response);
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.handler({ type: "error", message: "Connection closed" });
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }
}
