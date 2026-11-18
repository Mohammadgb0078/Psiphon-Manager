/**
 * Per-instance ring buffer logger and disk log manager
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class InstanceLogger extends EventEmitter {
  constructor(instanceId, options = {}) {
    super();
    this.setMaxListeners(50);
    this.instanceId = instanceId;
    this.maxLines = options.maxLines || 500;
    this.maxFileSizeBytes = options.maxFileSizeBytes || 10 * 1024 * 1024; // 10MB
    this.buffer = [];
    this.logDir = options.logDir || path.resolve('logs');
    this.logFile = path.join(this.logDir, `${instanceId}.log`);
    this.currentFileSize = 0;
    this.writeQueue = [];
    this.isWriting = false;

    this.initLogFile();
  }

  initLogFile() {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      if (fs.existsSync(this.logFile)) {
        const stats = fs.statSync(this.logFile);
        this.currentFileSize = stats.size;
        if (this.currentFileSize >= this.maxFileSizeBytes) {
          this.rotateLog();
        }
      } else {
        this.currentFileSize = 0;
      }
    } catch (err) {
      console.error(`[Logger ${this.instanceId}] Failed to initialize log file:`, err.message);
    }
  }

  rotateLog() {
    try {
      const oldFile = `${this.logFile}.old`;
      if (fs.existsSync(oldFile)) {
        try { fs.unlinkSync(oldFile); } catch {}
      }
      if (fs.existsSync(this.logFile)) {
        fs.renameSync(this.logFile, oldFile);
      }
      this.currentFileSize = 0;
    } catch (err) {
      // Ignore rotation error to avoid disrupting logger
    }
  }

  flushDiskQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;
    const batch = this.writeQueue.join('');
    this.writeQueue = [];

    fs.appendFile(this.logFile, batch, 'utf8', (err) => {
      this.isWriting = false;
      if (!err) {
        this.currentFileSize += Buffer.byteLength(batch, 'utf8');
        if (this.currentFileSize >= this.maxFileSizeBytes) {
          this.rotateLog();
        }
      }
      if (this.writeQueue.length > 0) {
        this.flushDiskQueue();
      }
    });
  }

  append(rawText) {
    if (typeof rawText !== 'string') {
      rawText = String(rawText);
    }

    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;

      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        text: line
      };

      this.buffer.push(logEntry);
      if (this.buffer.length > this.maxLines) {
        this.buffer.shift();
      }

      // Format line for disk persistence
      const diskLine = `[${timestamp}] ${line}\n`;
      this.writeQueue.push(diskLine);

      this.emit('line', logEntry);
    }

    this.flushDiskQueue();
  }

  getLines(tailCount = 50) {
    const count = Math.min(Math.max(1, tailCount), this.buffer.length);
    return this.buffer.slice(this.buffer.length - count);
  }

  close() {
    if (this.writeQueue.length > 0) {
      try {
        fs.appendFileSync(this.logFile, this.writeQueue.join(''), 'utf8');
        this.writeQueue = [];
      } catch (_) {}
    }
    this.removeAllListeners();
  }
}

class LogManager {
  constructor(options = {}) {
    this.logDir = options.logDir || path.resolve('logs');
    this.maxLines = options.maxLines || 500;
    this.loggers = new Map();
  }

  getLogger(instanceId) {
    if (!this.loggers.has(instanceId)) {
      const logger = new InstanceLogger(instanceId, {
        logDir: this.logDir,
        maxLines: this.maxLines
      });
      this.loggers.set(instanceId, logger);
    }
    return this.loggers.get(instanceId);
  }

  removeLogger(instanceId) {
    const logger = this.loggers.get(instanceId);
    if (logger) {
      logger.close();
      this.loggers.delete(instanceId);
    }
  }

  closeAll() {
    for (const logger of this.loggers.values()) {
      logger.close();
    }
    this.loggers.clear();
  }
}

module.exports = {
  InstanceLogger,
  LogManager
};
