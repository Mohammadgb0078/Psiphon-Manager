/**
 * Psiphon Instance Controller
 * Manages spawning, monitoring, log parsing, state tracking, and auto-restart of a single Psiphon core process.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { INSTANCE_STATUS } = require('./constants');
const { generateInstanceConfig } = require('./config');

function checkPortFree(port) {
  return new Promise((resolve) => {
    if (!port || port === 0) return resolve(true);
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

class PsiphonInstance {
  constructor(definition, options = {}) {
    this.id = definition.id;
    this.region = definition.region;
    this.socksPort = definition.socksPort;
    this.httpPort = definition.httpPort || 0;
    this.enabled = definition.enabled !== false;

    this.binaryPath = options.binaryPath || '/etc/psiphon-manager/bin/psiphon-tunnel-core-x86_64';
    this.extraArgs = options.extraArgs || [];
    this.baseConfig = options.baseConfig || {};
    this.dataRootDir = options.dataRootDir || path.resolve('data');
    this.instanceDataDir = path.join(this.dataRootDir, this.id);
    this.configFilePath = path.join(this.instanceDataDir, 'config.json');

    this.logger = options.logger; // InstanceLogger

    this.status = INSTANCE_STATUS.STOPPED;
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.connectedAt = null;
    this.restarts = 0;
    this.lastError = null;

    this.isManualStop = false;
    this.restartTimer = null;
    this.stopPromise = null;
  }

  /**
   * Generates isolated instance configuration file
   */
  prepareConfig() {
    if (!fs.existsSync(this.instanceDataDir)) {
      fs.mkdirSync(this.instanceDataDir, { recursive: true });
    }

    const instanceConfig = generateInstanceConfig(
      this.baseConfig,
      {
        socksPort: this.socksPort,
        httpPort: this.httpPort,
        region: this.region
      },
      this.instanceDataDir
    );

    fs.writeFileSync(this.configFilePath, JSON.stringify(instanceConfig, null, 2), 'utf8');
    return this.configFilePath;
  }

  resolveBinary() {
    const projectDir = path.resolve(this.dataRootDir, '..');
    return path.isAbsolute(this.binaryPath)
      ? this.binaryPath
      : path.resolve(projectDir, this.binaryPath);
  }

  /**
   * Start the psiphon process
   */
  async start() {
    if (this.child) {
      return;
    }

    this.isManualStop = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    try {
      this.prepareConfig();
    } catch (err) {
      this.status = INSTANCE_STATUS.ERROR;
      this.lastError = `Failed to prepare config: ${err.message}`;
      if (this.logger) this.logger.append(`[ERROR] ${this.lastError}`);
      return;
    }

    this.status = INSTANCE_STATUS.CONNECTING;
    this.startedAt = Date.now();
    this.connectedAt = null;

    // Pre-flight port availability check (Issue 4.3)
    const isSocksFree = await checkPortFree(this.socksPort);
    if (!isSocksFree) {
      this.status = INSTANCE_STATUS.ERROR;
      this.lastError = `Configured SOCKS port ${this.socksPort} is already in use by another process`;
      if (this.logger) this.logger.append(`[ERROR] ${this.lastError}`);
      this.scheduleAutoRestart();
      return;
    }

    if (this.httpPort > 0) {
      const isHttpFree = await checkPortFree(this.httpPort);
      if (!isHttpFree) {
        this.status = INSTANCE_STATUS.ERROR;
        this.lastError = `Configured HTTP port ${this.httpPort} is already in use by another process`;
        if (this.logger) this.logger.append(`[ERROR] ${this.lastError}`);
        this.scheduleAutoRestart();
        return;
      }
    }

    const effectiveBinary = this.resolveBinary();

    // Verify binary exists and is executable
    if (!fs.existsSync(effectiveBinary)) {
      this.status = INSTANCE_STATUS.ERROR;
      this.lastError = `Binary not found at: ${effectiveBinary}`;
      if (this.logger) this.logger.append(`[ERROR] ${this.lastError}`);
      this.scheduleAutoRestart();
      return;
    }

    if (process.platform !== 'win32') {
      try {
        fs.accessSync(effectiveBinary, fs.constants.X_OK);
      } catch {
        this.status = INSTANCE_STATUS.ERROR;
        this.lastError = `Binary at "${effectiveBinary}" is not executable. Run: chmod +x "${effectiveBinary}"`;
        if (this.logger) this.logger.append(`[ERROR] ${this.lastError}`);
        this.scheduleAutoRestart();
        return;
      }
    }

    const args = [
      ...this.extraArgs,
      '-config', this.configFilePath,
      '-dataRootDirectory', this.instanceDataDir
    ];

    if (this.logger) {
      this.logger.append(`[MANAGER] Spawning ${effectiveBinary} ${args.join(' ')}`);
    }

    try {
      const isCmdOrBat = process.platform === 'win32' && /\.(cmd|bat)$/i.test(effectiveBinary);
      this.child = spawn(effectiveBinary, args, {
        cwd: this.instanceDataDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        windowsHide: true,
        shell: isCmdOrBat,
        detached: process.platform !== 'win32'
      });
    } catch (err) {
      this.status = INSTANCE_STATUS.ERROR;
      this.lastError = `Spawn failed: ${err.message}`;
      if (this.logger) this.logger.append(`[ERROR] ${this.lastError}`);
      this.scheduleAutoRestart();
      return;
    }

    this.pid = this.child.pid;

    let stdoutBuffer = '';
    this.child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop(); // keep partial line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        if (this.logger) this.logger.append(line);
        this.parseLogLine(line);
      }
    });
    this.child.stdout.on('end', () => {
      if (stdoutBuffer && stdoutBuffer.trim()) {
        if (this.logger) this.logger.append(stdoutBuffer);
        this.parseLogLine(stdoutBuffer);
        stdoutBuffer = '';
      }
    });

    let stderrBuffer = '';
    this.child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (this.logger) this.logger.append(`[STDERR] ${line}`);
        this.parseLogLine(line);
      }
    });
    this.child.stderr.on('end', () => {
      if (stderrBuffer && stderrBuffer.trim()) {
        if (this.logger) this.logger.append(`[STDERR] ${stderrBuffer}`);
        this.parseLogLine(stderrBuffer);
        stderrBuffer = '';
      }
    });

    this.child.on('error', (err) => {
      this.status = INSTANCE_STATUS.ERROR;
      this.lastError = `Process error: ${err.message}`;
      if (this.logger) this.logger.append(`[ERROR] ${this.lastError}`);
      this.child = null;
      this.pid = null;
      this.scheduleAutoRestart();
    });

    this.child.on('exit', (code, signal) => {
      const exitMsg = `Process exited with code ${code}, signal ${signal}`;
      if (this.logger) this.logger.append(`[MANAGER] ${exitMsg}`);

      const wasConnectedLongEnough = this.connectedAt && (Date.now() - this.connectedAt > 60000);
      if (wasConnectedLongEnough) {
        this.restarts = 0;
      }

      this.child = null;
      this.pid = null;
      this.connectedAt = null;

      if (this.isManualStop) {
        this.status = INSTANCE_STATUS.STOPPED;
      } else {
        if (code === 0) {
          this.status = INSTANCE_STATUS.STOPPED;
        } else {
          this.status = INSTANCE_STATUS.ERROR;
          this.lastError = exitMsg;
        }

        if (this.enabled) {
          this.scheduleAutoRestart();
        }
      }
    });
  }

  /**
   * Parse Psiphon log output for state detection
   */
  parseLogLine(line) {
    // Try JSON notice parsing
    try {
      const json = JSON.parse(line);
      if (json && json.noticeType) {
        switch (json.noticeType) {
          case 'ListeningSocksProxyPort':
          case 'ListeningHttpProxyPort':
            if (this.status !== INSTANCE_STATUS.CONNECTED) {
              this.status = INSTANCE_STATUS.CONNECTING;
            }
            break;
          case 'ConnectedRegion':
          case 'ActiveTunnel':
          case 'Homepage':
            this.status = INSTANCE_STATUS.CONNECTED;
            if (!this.connectedAt) this.connectedAt = Date.now();
            this.lastError = null;
            break;
          case 'Tunnels':
            if (json.data && json.data.count > 0) {
              this.status = INSTANCE_STATUS.CONNECTED;
              if (!this.connectedAt) this.connectedAt = Date.now();
              this.lastError = null;
            } else if (json.data && json.data.count === 0 && this.status === INSTANCE_STATUS.CONNECTED) {
              this.status = INSTANCE_STATUS.CONNECTING;
            }
            break;
          case 'Connecting':
          case 'CandidateServers':
          case 'Handshake':
            if (this.status !== INSTANCE_STATUS.CONNECTED) {
              this.status = INSTANCE_STATUS.CONNECTING;
            }
            break;
          case 'SocksProxyPortInUse':
          case 'HttpProxyPortInUse':
            this.status = INSTANCE_STATUS.ERROR;
            this.lastError = `Proxy port already in use (${json.data ? json.data.port : ''})`;
            break;
          case 'Alert':
            if (json.data && json.data.error) {
              this.lastError = json.data.error;
            }
            break;
          case 'Exiting':
            this.status = INSTANCE_STATUS.STOPPED;
            break;
        }
        return;
      }
    } catch {
      // Non-JSON line, fallback to plaintext patterns
    }

    // Plaintext patterns (Issue 3.15: 'listening on' indicates local bind, not remote tunnel ready)
    if (/tunnel\s+established|connected\s+to\s+server|client\s+connected/i.test(line)) {
      this.status = INSTANCE_STATUS.CONNECTED;
      if (!this.connectedAt) this.connectedAt = Date.now();
      this.lastError = null;
    } else if (/listening\s+on|connecting|handshake/i.test(line)) {
      if (this.status !== INSTANCE_STATUS.CONNECTED) {
        this.status = INSTANCE_STATUS.CONNECTING;
      }
    } else if (/error|fatal|fail/i.test(line)) {
      this.lastError = line;
    }
  }

  /**
   * Schedule automatic restart with exponential backoff
   */
  scheduleAutoRestart() {
    if (this.isManualStop || !this.enabled) return;

    this.restarts++;
    const delay = Math.min(30000, 3000 * Math.pow(1.5, Math.min(this.restarts - 1, 6)));

    if (this.logger) {
      this.logger.append(`[MANAGER] Restarting in ${(delay / 1000).toFixed(1)}s (restart #${this.restarts})...`);
    }

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.enabled && !this.isManualStop) {
        this.start().catch((err) => {
          if (this.logger) this.logger.append(`[MANAGER RESTART ERROR] ${err.message}`);
        });
      }
    }, delay);
  }

  /**
   * Stop the child process cleanly
   */
  async stop() {
    this.isManualStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.stopPromise) {
      return this.stopPromise;
    }

    if (!this.child) {
      this.status = INSTANCE_STATUS.STOPPED;
      this.pid = null;
      this.connectedAt = null;
      return;
    }

    const child = this.child;
    const childPid = this.pid;

    this.stopPromise = new Promise((resolve) => {
      let resolved = false;
      let hardKillTimer = null;
      let checkInterval = null;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          if (hardKillTimer) clearTimeout(hardKillTimer);
          if (checkInterval) clearInterval(checkInterval);
          this.child = null;
          this.pid = null;
          this.connectedAt = null;
          this.status = INSTANCE_STATUS.STOPPED;
          this.stopPromise = null;
          resolve();
        }
      };

      child.once('exit', () => finish());

      // Attempt graceful SIGTERM
      try {
        if (process.platform !== 'win32' && childPid) {
          // Send to process group to terminate entire process tree
          try {
            process.kill(-childPid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // Child already dead
        finish();
        return;
      }

      // Hard kill fallback after 3 seconds, waiting until OS actually reaps the process (Issue 3.6 & 3.7)
      hardKillTimer = setTimeout(() => {
        if (!resolved) {
          try {
            if (process.platform !== 'win32' && childPid) {
              try {
                process.kill(-childPid, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
            } else {
              child.kill('SIGKILL');
            }
          } catch {
            // Ignore
          }

          // Await actual process termination before releasing port
          checkInterval = setInterval(() => {
            try {
              if (childPid) {
                process.kill(childPid, 0);
              } else {
                finish();
              }
            } catch {
              // ESRCH: process is gone from kernel table
              finish();
            }
          }, 100);

          // Absolute timeout guard
          setTimeout(() => {
            finish();
          }, 2000);
        }
      }, 3000);
    });

    return this.stopPromise;
  }

  /**
   * Restart instance
   */
  async restart() {
    await this.stop();
    await this.start();
  }

  /**
   * Public info snapshot for status reporting
   */
  getInfo() {
    const uptimeMs = this.status === INSTANCE_STATUS.CONNECTED && this.connectedAt
      ? Date.now() - this.connectedAt
      : 0;

    return {
      id: this.id,
      region: this.region,
      socksPort: this.socksPort,
      httpPort: this.httpPort,
      enabled: this.enabled,
      status: this.status,
      pid: this.pid,
      uptimeMs,
      restarts: this.restarts,
      lastError: this.lastError,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt
    };
  }
}

module.exports = {
  PsiphonInstance
};
