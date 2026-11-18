/**
 * Psiphon Multi-Instance Daemon Supervisor
 * Primary entry point for systemd service / background supervisor.
 */
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, validateInstance } = require('./config');
const { LogManager } = require('./logger');
const { PsiphonInstance } = require('./instance');
const { IpcServer } = require('./ipc');
const { LOCK_FILE_NAME, DEFAULT_CONFIG_FILE, getDefaultSocketPath } = require('./constants');

class DaemonSupervisor {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.configFile = path.resolve(this.projectDir, options.configFile || DEFAULT_CONFIG_FILE);
    this.lockFile = path.resolve(this.projectDir, LOCK_FILE_NAME);
    this.socketPath = options.socketPath || process.env.PSIPHON_SOCKET_PATH || getDefaultSocketPath(this.projectDir);
    this.extraArgs = options.extraArgs || [];

    this.config = null;
    this.logManager = new LogManager({
      logDir: path.resolve(this.projectDir, 'logs')
    });
    this.instances = new Map();
    this.ipcServer = null;
    this.startedAt = Date.now();
    this.isShuttingDown = false;
    this.configMutex = Promise.resolve();
  }

  async withConfigLock(fn) {
    const next = this.configMutex.then(fn, fn);
    this.configMutex = next.catch(() => {});
    return next;
  }

  /**
   * Initialize daemon: load config, spawn instances, start IPC, write lockfile
   */
  async start() {
    console.log('[DAEMON] Starting Psiphon Multi-Instance Manager...');
    console.log(`[DAEMON] Project directory: ${this.projectDir}`);
    console.log(`[DAEMON] Config file: ${this.configFile}`);
    console.log(`[DAEMON] Socket path: ${this.socketPath}`);

    // Register shutdown hooks early so boot signal races are caught cleanly
    this.registerSignalHandlers();

    // Load and validate config
    this.config = loadConfig(this.configFile);
    console.log(`[DAEMON] Loaded configuration with ${this.config.instances.length} instance(s).`);

    // Start IPC Server
    this.ipcServer = new IpcServer(this.socketPath, (action, payload, ctx) =>
      this.handleIpcRequest(action, payload, ctx)
    );
    await this.ipcServer.start();
    console.log(`[DAEMON] IPC Server listening on ${this.socketPath}`);

    // Write lockfile
    this.writeLockFile();

    // Start all enabled instances
    if (this.config.instances.length === 0) {
      console.log('[DAEMON] No instances configured yet. Ready to add tunnels via "psi-ui add".');
    } else {
      for (const instDef of this.config.instances) {
        await this.initAndStartInstance(instDef);
      }
    }

    console.log(`[DAEMON] Daemon successfully started with PID ${process.pid}`);
  }

  writeLockFile() {
    const lockData = {
      pid: process.pid,
      socketPath: this.socketPath,
      startedAt: new Date(this.startedAt).toISOString(),
      version: '1.0.0',
      projectDir: this.projectDir
    };

    fs.writeFileSync(this.lockFile, JSON.stringify(lockData, null, 2), 'utf8');

    // On Unix/Linux, write an auxiliary lock file in /tmp so any global invocation discovers it
    if (process.platform !== 'win32') {
      try {
        const auxLock = path.join('/tmp', 'psiphon-cli.lock');
        fs.writeFileSync(auxLock, JSON.stringify(lockData, null, 2), 'utf8');
        try { fs.chmodSync(auxLock, 0o666); } catch {}
      } catch {
        // Ignore auxiliary lock write error
      }
    }
  }

  removeLockFile() {
    try {
      if (fs.existsSync(this.lockFile)) {
        fs.unlinkSync(this.lockFile);
      }
    } catch (err) {
      console.error(`[DAEMON] Failed to remove lock file: ${err.message}`);
    }

    if (process.platform !== 'win32') {
      try {
        const auxLock = path.join('/tmp', 'psiphon-cli.lock');
        if (fs.existsSync(auxLock)) {
          fs.unlinkSync(auxLock);
        }
      } catch {
        // Ignore
      }
    }
  }

  async initAndStartInstance(instDef) {
    const logger = this.logManager.getLogger(instDef.id);
    const instance = new PsiphonInstance(instDef, {
      binaryPath: this.config.binaryPath,
      extraArgs: this.extraArgs,
      baseConfig: this.config.baseConfig,
      dataRootDir: path.resolve(this.projectDir, 'data'),
      logger
    });

    this.instances.set(instDef.id, instance);

    if (instDef.enabled !== false) {
      console.log(`[DAEMON] Starting instance "${instDef.id}" (${instDef.region} -> socks:${instDef.socksPort})...`);
      await instance.start();
    }
    return instance;
  }

  /**
   * Handle incoming IPC requests from CLI
   */
  async handleIpcRequest(action, payload, ctx) {
    if (this.isShuttingDown) {
      throw new Error('Psiphon daemon is shutting down. Requests are refused.');
    }

    switch (action) {
      case 'status':
      case 'list': {
        const instancesList = [];
        for (const inst of this.instances.values()) {
          instancesList.push(inst.getInfo());
        }

        const activeCount = instancesList.filter((i) => i.status === 'CONNECTED').length;

        return {
          daemon: {
            pid: process.pid,
            uptimeMs: Date.now() - this.startedAt,
            startedAt: new Date(this.startedAt).toISOString(),
            totalInstances: instancesList.length,
            activeInstances: activeCount
          },
          instances: instancesList
        };
      }

      case 'add': {
        return this.withConfigLock(async () => {
          const existingDefs = this.config.instances;
          const validated = validateInstance(payload, existingDefs, -1);

          // Check if instance already exists in supervisor
          if (this.instances.has(validated.id)) {
            throw new Error(`Instance "${validated.id}" already exists`);
          }

          // Add to config and save atomically before mutating in-memory state
          const newConfig = {
            ...this.config,
            instances: [...this.config.instances, validated]
          };
          saveConfig(this.configFile, newConfig);
          this.config = newConfig;

          // Start instance
          try {
            const instance = await this.initAndStartInstance(validated);
            return {
              message: `Instance "${validated.id}" added and started successfully`,
              instance: instance.getInfo()
            };
          } catch (startErr) {
            // Revert config save if instance failed to initialize
            const revertedConfig = {
              ...this.config,
              instances: this.config.instances.filter((i) => i.id !== validated.id)
            };
            try { saveConfig(this.configFile, revertedConfig); } catch (_) {}
            this.config = revertedConfig;
            this.instances.delete(validated.id);
            throw startErr;
          }
        });
      }

      case 'remove': {
        return this.withConfigLock(async () => {
          const { id } = payload;
          if (!id) throw new Error('Instance ID is required');

          const instance = this.instances.get(id);
          if (!instance) {
            throw new Error(`Instance "${id}" not found`);
          }

          // Stop instance
          await instance.stop();
          this.instances.delete(id);
          this.logManager.removeLogger(id);

          // Remove from config and save atomically
          const newConfig = {
            ...this.config,
            instances: this.config.instances.filter((inst) => inst.id !== id)
          };
          saveConfig(this.configFile, newConfig);
          this.config = newConfig;

          return { message: `Instance "${id}" removed successfully` };
        });
      }

      case 'restart': {
        return this.withConfigLock(async () => {
          const { id } = payload;
          if (!id) throw new Error('Instance ID is required');

          const instance = this.instances.get(id);
          if (!instance) {
            throw new Error(`Instance "${id}" not found`);
          }

          // If previously disabled, re-enable
          if (!instance.enabled) {
            instance.enabled = true;
            const found = this.config.instances.find((i) => i.id === id);
            if (found) {
              found.enabled = true;
              saveConfig(this.configFile, this.config);
            }
          }

          await instance.restart();
          return {
            message: `Instance "${id}" restarted successfully`,
            instance: instance.getInfo()
          };
        });
      }

      case 'restartAll': {
        return this.withConfigLock(async () => {
          const results = [];
          for (const [id, inst] of this.instances.entries()) {
            if (inst.enabled) {
              try {
                await inst.restart();
                results.push({ id, status: 'restarted' });
              } catch (err) {
                results.push({ id, status: `failed: ${err.message}` });
              }
            } else {
              results.push({ id, status: 'skipped (disabled)' });
            }
          }
          return { message: 'All instances processed', results };
        });
      }

      case 'stop': {
        return this.withConfigLock(async () => {
          const { id } = payload;
          if (!id) throw new Error('Instance ID is required');

          const instance = this.instances.get(id);
          if (!instance) {
            throw new Error(`Instance "${id}" not found`);
          }

          await instance.stop();
          instance.enabled = false;

          // Update config
          const found = this.config.instances.find((i) => i.id === id);
          if (found) found.enabled = false;
          saveConfig(this.configFile, this.config);

          return { message: `Instance "${id}" stopped`, instance: instance.getInfo() };
        });
      }

      case 'start': {
        return this.withConfigLock(async () => {
          const { id } = payload;
          if (!id) throw new Error('Instance ID is required');

          const instance = this.instances.get(id);
          if (!instance) {
            throw new Error(`Instance "${id}" not found`);
          }

          instance.enabled = true;
          await instance.start();

          // Update config
          const found = this.config.instances.find((i) => i.id === id);
          if (found) found.enabled = true;
          saveConfig(this.configFile, this.config);

          return { message: `Instance "${id}" started`, instance: instance.getInfo() };
        });
      }

      case 'logs': {
        const { id, tail, follow } = payload;
        if (!id) throw new Error('Instance ID is required');

        const instance = this.instances.get(id);
        if (!instance) {
          throw new Error(`Instance "${id}" not found`);
        }

        const logger = this.logManager.getLogger(id);
        const lines = logger.getLines(tail || 50);

        if (follow && ctx && ctx.socket) {
          const listener = (event) => {
            if (!ctx.socket.destroyed) {
              try {
                ctx.socket.write(
                  JSON.stringify({
                    id: ctx.reqId,
                    type: 'log_event',
                    event
                  }) + '\n'
                );
              } catch (writeErr) {
                logger.off('line', listener);
              }
            }
          };
          logger.on('line', listener);
          ctx.subscriptions.push(() => logger.off('line', listener));
        }

        return { lines };
      }

      default:
        throw new Error(`Unknown action: "${action}"`);
    }
  }

  /**
   * Graceful shutdown sequence
   */
  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('\n[DAEMON] Shutting down supervisor gracefully...');

    // 1. Close IPC server immediately to refuse new requests and prevent orphan spawns (Issue 3.1)
    if (this.ipcServer) {
      await this.ipcServer.close();
      this.ipcServer = null;
    }

    // 2. Stop all instances
    const stopPromises = [];
    for (const [id, inst] of this.instances.entries()) {
      console.log(`[DAEMON] Stopping instance "${id}"...`);
      stopPromises.push(inst.stop());
    }
    await Promise.all(stopPromises);

    // 3. Close loggers
    this.logManager.closeAll();

    // 4. Remove lockfile
    this.removeLockFile();

    console.log('[DAEMON] Shutdown complete.');
  }

  registerSignalHandlers() {
    const handleSignal = async (sig) => {
      console.log(`[DAEMON] Received signal: ${sig}`);
      await this.shutdown();
      process.exit(0);
    };

    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
    if (process.platform !== 'win32') {
      process.once('SIGHUP', () => handleSignal('SIGHUP'));
    }

    process.on('uncaughtException', async (err) => {
      console.error('[DAEMON FATAL] Uncaught Exception:', err);
      try {
        await this.shutdown();
      } catch (_) {}
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[DAEMON ERROR] Unhandled Rejection:', reason);
    });
  }
}

// If executed directly
if (require.main === module) {
  const supervisor = new DaemonSupervisor();
  supervisor.start().catch((err) => {
    console.error('[DAEMON FATAL] Failed to start daemon:', err);
    process.exit(1);
  });
}

module.exports = { DaemonSupervisor };
