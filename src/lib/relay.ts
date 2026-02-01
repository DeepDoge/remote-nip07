/**
 * Relay connection manager for NIP-46 communication
 */

import type { NostrEvent, SignedEvent } from "./nostr.ts";

export type RelayMessageHandler = (event: NostrEvent) => void;

export interface RelaySubscription {
  id: string;
  filters: RelayFilter[];
  onEvent: RelayMessageHandler;
}

export interface RelayFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  "#p"?: string[];
  "#e"?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

export class RelayPool {
  private sockets: Map<string, WebSocket> = new Map();
  private subscriptions: Map<string, RelaySubscription> = new Map();
  private messageQueue: Map<string, SignedEvent[]> = new Map();
  private connectionPromises: Map<string, Promise<void>> = new Map();

  constructor(private relayUrls: string[]) {}

  async connect(): Promise<void> {
    const promises = this.relayUrls.map((url) => this.connectToRelay(url));
    await Promise.allSettled(promises);

    // Ensure at least one connection succeeded
    const connected = Array.from(this.sockets.values()).some(
      (ws) => ws.readyState === WebSocket.OPEN,
    );

    if (!connected) {
      throw new Error("Failed to connect to any relay");
    }
  }

  private async connectToRelay(url: string): Promise<void> {
    if (this.connectionPromises.has(url)) {
      return this.connectionPromises.get(url);
    }

    const promise = new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(url);

        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`Connection timeout: ${url}`));
        }, 10000);

        ws.onopen = () => {
          clearTimeout(timeout);
          console.log(`[Relay] Connected to ${url}`);
          this.sockets.set(url, ws);

          // Send any queued messages
          const queue = this.messageQueue.get(url) || [];
          for (const event of queue) {
            ws.send(JSON.stringify(["EVENT", event]));
          }
          this.messageQueue.delete(url);

          // Resubscribe
          for (const sub of this.subscriptions.values()) {
            ws.send(JSON.stringify(["REQ", sub.id, ...sub.filters]));
          }

          resolve();
        };

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            this.handleMessage(url, data);
          } catch (e) {
            console.error("[Relay] Failed to parse message:", e);
          }
        };

        ws.onerror = (err) => {
          console.error(`[Relay] Error on ${url}:`, err);
        };

        ws.onclose = () => {
          console.log(`[Relay] Disconnected from ${url}`);
          this.sockets.delete(url);
          this.connectionPromises.delete(url);

          // Reconnect after delay
          setTimeout(() => {
            if (this.subscriptions.size > 0) {
              this.connectToRelay(url).catch(() => {});
            }
          }, 5000);
        };
      } catch (e) {
        reject(e);
      }
    });

    this.connectionPromises.set(url, promise);
    return promise;
  }

  private handleMessage(url: string, data: unknown[]) {
    const [type, ...rest] = data;
    console.log(`[Relay] ${url} - Message type: ${type}`, rest);

    switch (type) {
      case "EVENT": {
        const [subId, event] = rest as [string, NostrEvent];
        console.log(
          `[Relay] ${url} - Received event for sub ${subId}:`,
          event?.id,
        );
        const sub = this.subscriptions.get(subId);
        if (sub) {
          console.log(`[Relay] Found subscription, calling handler`);
          sub.onEvent(event);
        } else {
          console.log(
            `[Relay] No subscription found for ${subId}, known subs:`,
            Array.from(this.subscriptions.keys()),
          );
        }
        break;
      }
      case "OK": {
        const [eventId, success, message] = rest as [string, boolean, string];
        console.log(
          `[Relay] ${url} - Event ${eventId}: ${success ? "OK" : message}`,
        );
        break;
      }
      case "EOSE": {
        const [subId] = rest as [string];
        console.log(`[Relay] ${url} - End of stored events for ${subId}`);
        break;
      }
      case "NOTICE": {
        const [message] = rest as [string];
        console.log(`[Relay] ${url} - Notice: ${message}`);
        break;
      }
    }
  }

  subscribe(
    id: string,
    filters: RelayFilter[],
    onEvent: RelayMessageHandler,
  ): void {
    this.subscriptions.set(id, { id, filters, onEvent });

    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["REQ", id, ...filters]));
      }
    }
  }

  unsubscribe(id: string): void {
    this.subscriptions.delete(id);

    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["CLOSE", id]));
      }
    }
  }

  publish(event: SignedEvent): void {
    const message = JSON.stringify(["EVENT", event]);

    for (const [url, ws] of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      } else {
        // Queue for when connection is restored
        const queue = this.messageQueue.get(url) || [];
        queue.push(event);
        this.messageQueue.set(url, queue);
      }
    }
  }

  close(): void {
    for (const ws of this.sockets.values()) {
      ws.close();
    }
    this.sockets.clear();
    this.subscriptions.clear();
    this.connectionPromises.clear();
  }

  get isConnected(): boolean {
    return Array.from(this.sockets.values()).some(
      (ws) => ws.readyState === WebSocket.OPEN,
    );
  }
}
