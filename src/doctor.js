/**
 * System Doctor & Health Check Diagnostic Utility
 * Checks Node/npm environment, systemd service state, stale lock file,
 * startup registration, running instances, and proxy ports.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { c, formatUptime } = require('./ui');
const { LOCK_FILE_NAME, getLockCandidates } = require('./constants');
const { IpcClient } = require('./ipc');

class SystemDoctor {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.issues = 0;
    this.warnings = 0;
  }

  logStep(status, title, details = '') {
    let icon = c.green('✔');
    if (status === 'fail') {
      icon = c.red('✖');
      this.issues++;
    } else if (status === 'warn') {
      icon = c.yellow('⚠');
      this.warnings++;
    } else if (status === 'info') {
      icon = c.cyan('ℹ');
    }

    let line = `${icon} ${c.bold(title)}`;
    if (details) {
      line += ` ${c.gray('—')} ${details}`;
    }
    console.log(`  ${line}`);
  }

  /**
   * 1. Check Node.js and npm runtime
   */
  checkNodeEnvironment() {
    const nodeVer = process.version;
    const nodePath = process.execPath;
    let npmVer = 'Not found';

    try {
      npmVer = execSync('npm -v', { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      // npm not found
    }

    const majorVer = parseInt(nodeVer.replace(/^v/, '').split('.')[0], 10);
    if (majorVer >= 24) {
      this.logStep('ok', 'Node.js Runtime', `${c.green(nodeVer)} at ${c.gray(nodePath)}`);
    } else if (majorVer >= 20) {
      this.logStep('ok', 'Node.js Runtime', `${c.green(nodeVer)} (v24.x recommended) at ${c.gray(nodePath)}`);
    } else {
      this.logStep('warn', 'Node.js Runtime', `${c.yellow(nodeVer)} is outdated (min v20+ / v24+ recommended)`);
    }

    if (npmVer !== 'Not found') {
      this.logStep('ok', 'NPM Package Manager', `${c.green(`v${npmVer}`)}`);
    } else {
      this.logStep('warn', 'NPM Package Manager', c.yellow('npm binary was not detected in PATH'));
    }
  }

  /**
   * Check Psiphon Core Binary file
   */
  checkPsiphonBinary() {
    let binaryPath = './bin/psiphon-tunnel-core-x86_64';
    try {
      const configPath = path.resolve(this.projectDir, 'config.json');
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (parsed.binaryPath) {
          binaryPath = parsed.binaryPath;
        }
      }
    } catch {
      // Use default
    }

    let resolved = path.isAbsolute(binaryPath)
      ? binaryPath
      : path.resolve(this.projectDir, binaryPath);

    if (!fs.existsSync(resolved) && fs.existsSync('/etc/psiphon-manager/bin/psiphon-tunnel-core-x86_64')) {
      resolved = '/etc/psiphon-manager/bin/psiphon-tunnel-core-x86_64';
    }

    if (!fs.existsSync(resolved)) {
      this.logStep('fail', 'Psiphon Core Binary', `${c.red('Missing')} at ${c.gray(resolved)}. Run install.sh or download to bin/`);
      return false;
    }

    if (process.platform !== 'win32') {
      try {
        fs.accessSync(resolved, fs.constants.X_OK);
        this.logStep('ok', 'Psiphon Core Binary', `${c.green('Executable')} at ${c.gray(resolved)}`);
      } catch {
        this.logStep('fail', 'Psiphon Core Binary', `${c.red('Not executable')} at ${c.gray(resolved)}. Run: chmod +x "${resolved}"`);
        return false;
      }
    } else {
      this.logStep('ok', 'Psiphon Core Binary', `${c.green('Present')} at ${c.gray(resolved)}`);
    }
    return true;
  }

  /**
   * 2. Check systemd service status
   */
  checkSystemdService() {
    if (process.platform !== 'linux') {
      this.logStep('info', 'Systemd Service', c.gray('Skipped (not running on Linux)'));
      return { active: null, enabled: null };
    }

    // Check if systemd is active on this Linux host (Issue 4.6)
    if (!fs.existsSync('/run/systemd/system')) {
      this.logStep('info', 'Systemd Service', c.gray('Skipped (systemd not running in this environment, e.g. Docker/WSL)'));
      return { active: null, enabled: null };
    }

    let activeState = 'unknown';
    let enabledState = 'unknown';

    try {
      activeState = execSync('systemctl is-active psiphon-manager.service', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
    } catch (err) {
      activeState = err.stdout ? err.stdout.trim() : 'inactive';
    }

    try {
      enabledState = execSync('systemctl is-enabled psiphon-manager.service', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
    } catch (err) {
      enabledState = err.stdout ? err.stdout.trim() : 'disabled';
    }

    // Evaluate active state
    if (activeState === 'active') {
      this.logStep('ok', 'Systemd Service Status', `${c.green('active (running)')} [psiphon-manager.service]`);
    } else if (activeState === 'failed') {
      this.logStep('fail', 'Systemd Service Status', `${c.red('failed')} — check journalctl -u psiphon-manager -e`);
    } else {
      this.logStep('warn', 'Systemd Service Status', `${c.yellow(activeState)} — not currently running`);
    }

    // Evaluate enabled state
    if (enabledState === 'enabled') {
      this.logStep('ok', 'Service Auto-Start on Boot', `${c.green('enabled')}`);
    } else {
      this.logStep('warn', 'Service Auto-Start on Boot', `${c.yellow(enabledState)} — run: sudo systemctl enable psiphon-manager`);
    }

    return { active: activeState === 'active', enabled: enabledState === 'enabled' };
  }

  /**
   * 3. Check lock file & detect unexpected power loss / crash (Issue 3.11)
   */
  checkLockFile(serviceActive) {
    const candidates = getLockCandidates(this.projectDir);
    if (process.env.PSIPHON_LOCK_PATH) {
      candidates.unshift(process.env.PSIPHON_LOCK_PATH);
    }

    let activeLock = null;
    let staleLock = null;
    let stalePath = null;

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, 'utf8');
          const data = JSON.parse(raw);
          if (data && Number.isInteger(data.pid) && data.pid > 0 && data.socketPath) {
            let isAlive = false;
            try {
              process.kill(data.pid, 0);
              isAlive = true;
            } catch (err) {
              isAlive = err.code === 'EPERM';
            }

            if (isAlive) {
              activeLock = { ...data, lockPath: p };
              break; // Found running active daemon
            } else if (!staleLock) {
              staleLock = data;
              stalePath = p;
            }
          }
        } catch {
          // Ignore parse error
        }
      }
    }

    if (activeLock) {
      this.logStep('ok', 'Daemon Process & IPC', `Running with PID ${c.cyan(activeLock.pid)} on socket ${c.gray(activeLock.socketPath)}`);
      return activeLock;
    }

    if (staleLock) {
      this.logStep(
        'fail',
        'Stale Lock Detected',
        `${c.red(`Dead PID ${staleLock.pid}`)} found in ${c.gray(stalePath)}. Server rebooted or process terminated abnormally!`
      );
      return null;
    }

    if (serviceActive === true) {
      this.logStep('warn', 'Daemon Lock File', 'Service is active but cli.lock not found yet (starting up?)');
    } else {
      this.logStep('info', 'Daemon Lock File', 'No lock file present (service is stopped)');
    }
    return null;
  }

  /**
   * 4. Query live instance stats via IPC
   */
  async checkInstances(lockData) {
    if (!lockData || !lockData.socketPath) {
      this.logStep('info', 'Active Tunnels', c.gray('Daemon is not running, skipping instance queries'));
      return;
    }

    const client = new IpcClient(lockData.socketPath);
    try {
      const statusData = await client.request('status');
      const { daemon, instances } = statusData;

      const totalUptimeStr = formatUptime(daemon.uptimeMs);
      this.logStep('ok', 'Supervisor Overall Uptime', `${c.green(totalUptimeStr)} (Daemon PID: ${daemon.pid})`);

      if (!instances || instances.length === 0) {
        this.logStep('warn', 'Active Tunnels', 'No instances configured in config.json');
        return;
      }

      const connected = instances.filter((i) => i.status === 'CONNECTED');
      const connecting = instances.filter((i) => i.status === 'CONNECTING');
      const stopped = instances.filter((i) => i.status === 'STOPPED');
      const errored = instances.filter((i) => i.status === 'ERROR');

      const summaryParts = [
        c.green(`${connected.length} connected`),
        connecting.length > 0 ? c.yellow(`${connecting.length} connecting`) : null,
        stopped.length > 0 ? c.gray(`${stopped.length} stopped`) : null,
        errored.length > 0 ? c.red(`${errored.length} error`) : null
      ].filter(Boolean);

      this.logStep('ok', 'Tunnel Instances Summary', `${instances.length} total (${summaryParts.join(', ')})`);

      // Print per-instance details
      for (const inst of instances) {
        const flag = inst.region;
        const uptimeStr = inst.status === 'CONNECTED' ? `uptime: ${formatUptime(inst.uptimeMs)}` : inst.status.toLowerCase();
        let statusBadge = c.green('● ACTIVE');
        if (inst.status === 'CONNECTING') statusBadge = c.yellow('○ CONNECTING');
        if (inst.status === 'STOPPED') statusBadge = c.gray('■ STOPPED');
        if (inst.status === 'ERROR') statusBadge = c.red('✖ ERROR');

        const portStr = inst.httpPort > 0 ? `SOCKS:${inst.socksPort} | HTTP:${inst.httpPort}` : `SOCKS:${inst.socksPort}`;
        this.logStep(
          inst.status === 'CONNECTED' ? 'ok' : inst.status === 'ERROR' ? 'fail' : 'info',
          `  Instance "${inst.id}" [${flag}]`,
          `${statusBadge} | ${portStr} | ${c.gray(uptimeStr)}`
        );
      }
    } catch (err) {
      this.logStep('warn', 'Daemon IPC Connection', `Unable to query live stats: ${err.message}`);
    }
  }

  /**
   * Run full diagnostics
   */
  async run() {
    console.log('\n' + c.bold(c.cyan('═══════════════════ Psiphon Doctor Diagnostics ═══════════════════')));
    console.log(c.gray(`Timestamp: ${new Date().toLocaleString()} | OS: ${process.platform} (${process.arch})\n`));

    // 1. Node & NPM
    this.checkNodeEnvironment();

    // 2. Psiphon Core Binary
    this.checkPsiphonBinary();

    // 3. Systemd service
    const { active } = this.checkSystemdService();

    // 4. Lock & stale check
    const lock = this.checkLockFile(active);

    // 5. Live instances & uptime
    await this.checkInstances(lock);

    console.log('───────────────────────────────────────────────────────────────────');
    if (this.issues === 0 && this.warnings === 0) {
      console.log(c.bold(c.green('  ✔ All diagnostic checks passed! System is operating normally.')));
    } else if (this.issues === 0) {
      console.log(c.bold(c.yellow(`  ⚠ Diagnostics completed with ${this.warnings} warning(s).`)));
    } else {
      console.log(c.bold(c.red(`  ✖ Diagnostics detected ${this.issues} issue(s) and ${this.warnings} warning(s).`)));
    }
    console.log('═══════════════════════════════════════════════════════════════════\n');
  }
}

module.exports = {
  SystemDoctor
};
