/**
 * Unix Domain Socket / Named Pipe IPC Server and Client
 */
const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');

class IpcServer extends EventEmitter {
  constructor(socketPath, requestHandler) {
    super();
    this.socketPath = socketPath;
    this.requestHandler = requestHandler;
    this.server = null;
    this.activeSockets = new Set();
  }

  async start() {
    // If Unix socket file already exists, check whether another daemon is active before unlinking
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      const isAlive = await new Promise((res) => {
        const client = net.createConnection(this.socketPath);
        const timer = setTimeout(() => {
          client.destroy();
          res(false);
        }, 1000);
        client.on('connect', () => {
          clearTimeout(timer);
          client.destroy();
          res(true);
        });
        client.on('error', () => {
          clearTimeout(timer);
          res(false);
        });
      });

      if (isAlive) {
        throw new Error(`Another Psiphon daemon is already running and listening on ${this.socketPath}`);
      }

      try {
        fs.unlinkSync(this.socketPath);
      } catch (err) {
        // Ignore unlink error if file doesn't exist
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.activeSockets.add(socket);
        const clientContext = {
          socket,
          subscriptions: []
        };

        let buffer = '';
        let processing = false;
        const requestQueue = [];

        const processQueue = async () => {
          if (processing) return;
          processing = true;
          while (requestQueue.length > 0) {
            const line = requestQueue.shift();
            if (!line.trim()) continue;
            let req;
            try {
              req = JSON.parse(line);
            } catch {
              if (!socket.destroyed) {
                socket.write(JSON.stringify({ success: false, error: 'Malformed JSON payload' }) + '\n');
              }
              continue;
            }

            try {
              const reqCtx = {
                socket: clientContext.socket,
                subscriptions: clientContext.subscriptions,
                reqId: req.id
              };
              const result = await this.requestHandler(req.action, req.payload || {}, reqCtx);
              const response = {
                id: req.id,
                success: true,
                data: result
              };
              if (!socket.destroyed) {
                socket.write(JSON.stringify(response) + '\n');
              }
            } catch (err) {
              const response = {
                id: req.id,
                success: false,
                error: err.message
              };
              if (!socket.destroyed) {
                socket.write(JSON.stringify(response) + '\n');
              }
            }
          }
          processing = false;
        };

        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          // Guard against unbounded buffer memory exhaustion (Issue 3.13)
          if (buffer.length > 64 * 1024) {
            socket.destroy(new Error('IPC payload exceeded maximum buffer size (64KB)'));
            return;
          }

          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep remainder

          for (const line of lines) {
            requestQueue.push(line);
          }
          processQueue().catch(() => {});
        });

        socket.on('error', () => {
          // Socket error, handled by close
        });

        socket.on('close', () => {
          this.activeSockets.delete(socket);
          // Clean up subscriptions
          for (const unsub of clientContext.subscriptions) {
            try {
              unsub();
            } catch {
              // Ignore cleanup error
            }
          }
          clientContext.subscriptions = [];
        });
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Ensure Unix domain socket is accessible to non-root users
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.socketPath, 0o666);
          } catch {
            // Ignore chmod error if not permitted
          }
        }
        resolve();
      });
    });
  }

  async close() {
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    if (process.platform !== 'win32') {
      try {
        if (fs.existsSync(this.socketPath)) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {
        // Ignore
      }
    }
  }
}

class IpcClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
  }

  /**
   * Send a single request to the daemon and wait for response
   */
  async request(action, payload = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let buffer = '';
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (!socket.destroyed) socket.destroy();
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`IPC request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.on('connect', () => {
        const msg = JSON.stringify({ id: reqId, action, payload }) + '\n';
        socket.write(msg);
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const res = JSON.parse(line);
            if (res.id === reqId) {
              cleanup();
              if (res.success) {
                resolve(res.data);
              } else {
                reject(new Error(res.error || 'Unknown IPC error'));
              }
              return;
            }
          } catch {
            // Wait for next complete line
          }
        }
      });

      socket.on('error', (err) => {
        cleanup();
        reject(err);
      });

      socket.on('close', () => {
        cleanup();
        reject(new Error('Connection closed by IPC server'));
      });
    });
  }

  /**
   * Stream logs from daemon
   */
  async streamLogs(instanceId, tailCount = 50, onLine = () => {}, onClose = () => {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const reqId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let buffer = '';
      let initialResolved = false;
      const queuedEvents = [];
      let isReadyForLive = false;

      let handshakeTimer = setTimeout(() => {
        if (!initialResolved) {
          socket.destroy();
          reject(new Error('Timed out waiting for initial log stream response'));
        }
      }, 10000);

      socket.on('connect', () => {
        const msg = JSON.stringify({
          id: reqId,
          action: 'logs',
          payload: { id: instanceId, tail: tailCount, follow: true }
        }) + '\n';
        socket.write(msg);
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === reqId) {
              if (!initialResolved) {
                initialResolved = true;
                clearTimeout(handshakeTimer);
                if (!msg.success) {
                  socket.destroy();
                  reject(new Error(msg.error || 'Failed to fetch initial logs'));
                  return;
                }
                // Return initial lines and the stop function
                resolve({
                  initialLines: msg.data.lines,
                  startLive: () => {
                    if (!isReadyForLive) {
                      isReadyForLive = true;
                      while (queuedEvents.length > 0) {
                        onLine(queuedEvents.shift());
                      }
                    }
                  },
                  close: () => socket.destroy()
                });

                // Auto-flush queued events on next tick if caller does not explicitly call startLive()
                setImmediate(() => {
                  if (!isReadyForLive) {
                    isReadyForLive = true;
                    while (queuedEvents.length > 0) {
                      onLine(queuedEvents.shift());
                    }
                  }
                });
              } else if (msg.type === 'log_event') {
                if (isReadyForLive) {
                  onLine(msg.event);
                } else {
                  queuedEvents.push(msg.event);
                }
              }
            }
          } catch {
            // Ignore parse error on partial chunks
          }
        }
      });

      socket.on('error', (err) => {
        clearTimeout(handshakeTimer);
        if (!initialResolved) {
          reject(err);
        }
      });

      socket.on('close', () => {
        clearTimeout(handshakeTimer);
        if (onClose) onClose();
      });
    });
  }
}

module.exports = {
  IpcServer,
  IpcClient
};
