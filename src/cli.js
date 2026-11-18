#!/usr/bin/env node

/**
 * Psiphon Multi-Instance Manager CLI
 * Interacts with running daemon via IPC socket defined in cli.lock.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { Command } = require('commander');
const { IpcClient } = require('./ipc');
const { LOCK_FILE_NAME, ALLOWED_REGIONS, getLockCandidates } = require('./constants');
const { c, formatStatus, formatUptime, formatTable } = require('./ui');
const { SystemDoctor } = require('./doctor');

// Check root privileges on Linux / Unix platforms (Issue 3.2 requirement)
if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
  console.error('\x1b[31m[ERROR] psi-ui requires root privileges to manage system services and network tunnels.\x1b[0m');
  console.error('\x1b[33mPlease re-run using sudo:\x1b[0m sudo psi-ui ' + process.argv.slice(2).join(' ') + '\n');
  process.exit(1);
}

/**
 * Find and read cli.lock from candidate locations with active PID validation (Issue 3.11)
 */
function getLockData(projectDir = process.cwd()) {
  const candidates = getLockCandidates(projectDir);
  if (process.env.PSIPHON_LOCK_PATH) {
    candidates.unshift(process.env.PSIPHON_LOCK_PATH);
  }

  let staleFallback = null;

  for (const lockPath of candidates) {
    if (fs.existsSync(lockPath)) {
      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const data = JSON.parse(raw);
        if (data && Number.isInteger(data.pid) && data.pid > 0 && data.socketPath) {
          data.resolvedLockPath = lockPath;
          let isAlive = false;
          try {
            process.kill(data.pid, 0);
            isAlive = true;
          } catch (err) {
            isAlive = err.code === 'EPERM';
          }
          if (isAlive) {
            return data;
          } else if (!staleFallback) {
            staleFallback = data;
          }
        }
      } catch {
        // Continue searching other candidate locations
      }
    }
  }

  return staleFallback;
}

/**
 * Verify daemon is alive via PID check and get IPC client
 */
function getClientOrExit(projectDir = process.cwd(), exitOnError = true) {
  const lock = getLockData(projectDir);
  if (!lock) {
    if (exitOnError) {
      console.error(c.red('\n[ERROR] Psiphon daemon is not running! (cli.lock not found)'));
      console.error(c.yellow('Please start the daemon first:'));
      console.error(`  sudo systemctl start psiphon-manager`);
      console.error(`  or: npm start\n`);
      process.exit(1);
    }
    return null;
  }

  // Check if process is alive
  let isAlive = false;
  try {
    process.kill(lock.pid, 0);
    isAlive = true;
  } catch (err) {
    isAlive = err.code === 'EPERM'; // process exists but we lack permission to signal
  }

  if (!isAlive) {
    if (exitOnError) {
      console.error(c.red(`\n[ERROR] Stale cli.lock detected! Daemon (PID ${lock.pid}) is not running.`));
      console.error(c.yellow('Please restart the daemon:'));
      console.error(`  sudo systemctl restart psiphon-manager\n`);
      process.exit(1);
    }
    return null;
  }

  return new IpcClient(lock.socketPath);
}

/**
 * Format and print instances table
 */
function printStatusTable(data) {
  const { daemon, instances } = data;

  console.log('\n' + c.bold('══════════════════════════════════════════════════════════════'));
  console.log(c.bold(c.cyan('            Psiphon Multi-Instance Supervisor Status          ')));
  console.log(c.bold('══════════════════════════════════════════════════════════════'));
  console.log(
    `Daemon PID: ${c.green(daemon.pid)} | Uptime: ${c.yellow(formatUptime(daemon.uptimeMs))} | Active: ${c.green(
      daemon.activeInstances
    )}/${daemon.totalInstances}`
  );
  console.log('──────────────────────────────────────────────────────────────\n');

  if (!instances || instances.length === 0) {
    console.log(c.gray('No instances configured. Add one with: psi-ui add --region DE --socks 2478\n'));
    return;
  }

  const headers = ['ID', 'Region', 'SOCKS5 Port', 'HTTP Port', 'Status', 'PID', 'Uptime', 'Restarts'];
  const rows = instances.map((inst) => [
    c.bold(inst.id),
    inst.region,
    inst.socksPort,
    inst.httpPort > 0 ? inst.httpPort : c.gray('disabled'),
    formatStatus(inst.status),
    inst.pid || c.gray('-'),
    formatUptime(inst.uptimeMs),
    inst.restarts > 0 ? c.yellow(inst.restarts) : '0'
  ]);

  console.log(formatTable(headers, rows));
  console.log('');
}

/**
 * Update project from git and restart service
 */
async function runUpdate() {
  console.log('\n' + c.bold(c.cyan('═══════════════ Update Psiphon Multi Manager ═══════════════')));
  const targetDir = fs.existsSync('/etc/psiphon-manager/.git') ? '/etc/psiphon-manager' : process.cwd();
  console.log(c.blue(`▶ Target directory: ${targetDir}`));

  try {
    console.log(c.blue('▶ Pulling latest code from git repository...'));
    execSync('git pull origin main --quiet', { cwd: targetDir, stdio: 'inherit', timeout: 30000 });

    console.log(c.blue('▶ Updating dependencies (npm install)...'));
    execSync('npm install --omit=dev --silent', { cwd: targetDir, stdio: 'inherit', timeout: 60000 });

    console.log(c.blue('▶ Setting executable permissions on CLI...'));
    const cliPath = path.join(targetDir, 'src/cli.js');
    if (fs.existsSync(cliPath)) {
      try { fs.chmodSync(cliPath, 0o755); } catch {}
    }

    if (process.platform === 'linux' && fs.existsSync('/run/systemd/system')) {
      console.log(c.blue('▶ Restarting psiphon-manager.service...'));
      try {
        execSync('systemctl restart psiphon-manager.service', { stdio: 'inherit', timeout: 15000 });
      } catch (svcErr) {
        console.log(c.yellow(`  ⚠ Note on service restart: ${svcErr.message}`));
      }
    }

    console.log(c.bold(c.green('\n✔ Psiphon Multi Manager updated successfully!')));
  } catch (err) {
    console.error(c.bold(c.red(`\n✖ Update failed: ${err.message}`)));
  }
}

/**
 * Uninstall Psiphon Multi Manager, stopping services and removing files
 */
async function runUninstall(askTrimmed, rl) {
  console.log('\n' + c.bold(c.red('═══════════════ Uninstall Psiphon Multi Manager ═══════════════')));
  console.log(c.yellow('This will stop all running tunnels, remove the systemd service, and unregister psi-ui.'));

  const confirm = await askTrimmed(c.bold('Are you sure you want to proceed? (y/N): '));
  if (!confirm || (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes')) {
    console.log(c.cyan('Uninstallation cancelled.'));
    return false;
  }

  try {
    if (process.platform === 'linux') {
      console.log(c.blue('▶ Stopping and disabling systemd service...'));
      try { execSync('systemctl stop psiphon-manager.service', { stdio: 'ignore', timeout: 10000 }); } catch {}
      try { execSync('systemctl disable psiphon-manager.service', { stdio: 'ignore', timeout: 10000 }); } catch {}

      if (fs.existsSync('/etc/systemd/system/psiphon-manager.service')) {
        console.log(c.blue('▶ Removing systemd service file...'));
        try { fs.unlinkSync('/etc/systemd/system/psiphon-manager.service'); } catch {}
        try { execSync('systemctl daemon-reload', { stdio: 'ignore', timeout: 10000 }); } catch {}
      }
    }

    console.log(c.blue('▶ Removing global CLI shortcut (/usr/local/bin/psi-ui)...'));
    try {
      if (fs.existsSync('/usr/local/bin/psi-ui')) {
        fs.unlinkSync('/usr/local/bin/psi-ui');
      }
    } catch {}

    console.log(c.blue('▶ Cleaning temporary sockets and lock files...'));
    try {
      if (fs.existsSync('/tmp/psiphon-manager.sock')) fs.unlinkSync('/tmp/psiphon-manager.sock');
      if (fs.existsSync('/tmp/psiphon-cli.lock')) fs.unlinkSync('/tmp/psiphon-cli.lock');
    } catch {}

    const deleteData = await askTrimmed(c.yellow('Do you also want to delete all configuration, logs, and data in /etc/psiphon-manager? (y/N): '));
    if (deleteData && (deleteData.toLowerCase() === 'y' || deleteData.toLowerCase() === 'yes')) {
      if (fs.existsSync('/etc/psiphon-manager')) {
        console.log(c.blue('▶ Removing /etc/psiphon-manager directory...'));
        try {
          fs.rmSync('/etc/psiphon-manager', { recursive: true, force: true });
        } catch (rmErr) {
          console.error(c.yellow(`  Could not remove /etc/psiphon-manager: ${rmErr.message}`));
        }
      }
    }

    console.log(c.bold(c.green('\n✔ Psiphon Multi Manager has been completely uninstalled.')));
    if (rl) rl.close();
    process.exit(0);
  } catch (err) {
    console.error(c.bold(c.red(`\n✖ Uninstallation encountered an error: ${err.message}`)));
    return false;
  }
}

/**
 * Interactive terminal menu when no CLI arguments are supplied
 */
async function runInteractiveMenu(initialClient) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let rlClosed = false;
  rl.on('close', () => {
    rlClosed = true;
  });

  const ask = (query) =>
    new Promise((resolve) => {
      if (rlClosed) return resolve(null);
      rl.question(query, (answer) => resolve(answer));
    });

  // Safe prompt helper to prevent EOF (Ctrl+D) TypeError crashes (Issue 3.8)
  const askTrimmed = async (query) => {
    const raw = await ask(query);
    return raw === null ? null : raw.trim();
  };

  // Re-evaluates daemon socket dynamically to prevent stale caching (Issue 3.10)
  const getActiveClient = () => {
    return getClientOrExit(process.cwd(), false);
  };

  const showMenu = async () => {
    while (!rlClosed) {
      console.clear();
      const currentClient = getActiveClient();
      console.log('\n' + c.bold(c.cyan('═══════════════ Psiphon Multi Manager (psi-ui) ═══════════════')));
      if (!currentClient) {
        console.log(c.yellow('  ⚠ Daemon is currently stopped. Use [8] Doctor for diagnostics.'));
      }
      console.log(` ${c.bold('[1]')} View Instances Status`);
      console.log(` ${c.bold('[2]')} Add New Instance`);
      console.log(` ${c.bold('[3]')} Remove Instance`);
      console.log(` ${c.bold('[4]')} Restart Instance`);
      console.log(` ${c.bold('[5]')} Restart All Instances`);
      console.log(` ${c.bold('[6]')} View / Follow Logs`);
      console.log(` ${c.bold('[7]')} Start / Stop Instance`);
      console.log(` ${c.bold('[8]')} Doctor (Diagnostics & Health Check)`);
      console.log(` ${c.bold('[9]')} Update (Pull Latest Code & Restart)`);
      console.log(` ${c.bold('[10]')} Uninstall (Remove Service & Files)`);
      console.log(` ${c.bold('[11]')} Exit`);
      console.log('─────────────────────────────────────────────────────────────');

      const rawChoice = await askTrimmed(c.bold('Select an option (1-11): '));
      if (rawChoice === null) {
        break; // EOF reached (Ctrl+D)
      }
      const choice = rawChoice;

      // Check if client is required for this action
      const needsClient = ['1', '2', '3', '4', '5', '6', '7'].includes(choice);
      const activeClient = needsClient ? getActiveClient() : null;
      if (needsClient && !activeClient) {
        console.error(c.red('\n✖ Daemon is not running! Start it with: sudo systemctl start psiphon-manager'));
        console.error(c.gray('Tip: Run [8] Doctor to diagnose any system or lock issues.'));
        await ask(c.gray('Press Enter to continue...'));
        continue;
      }

      switch (choice) {
        case '1': {
          try {
            const data = await activeClient.request('status');
            printStatusTable(data);
          } catch (err) {
            console.error(c.red(`Failed: ${err.message}`));
          }
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '2': {
          console.log('\n' + c.bold('Add New Instance:'));
          console.log(c.gray(`Supported Regions: ${ALLOWED_REGIONS.join(', ')}`));
          const regionRaw = await askTrimmed('Region (e.g. DE, US, SG): ');
          if (regionRaw === null) break;
          const region = regionRaw.toUpperCase();

          const socksStr = await askTrimmed('SOCKS5 Port (e.g. 2480, or Enter to skip if using HTTP): ');
          if (socksStr === null) break;
          const httpStr = await askTrimmed('HTTP Port (e.g. 8080, optional / Enter to skip): ');
          if (httpStr === null) break;

          const socksPort = socksStr ? parseInt(socksStr, 10) : 0;
          const httpPort = httpStr ? parseInt(httpStr, 10) : 0;

          if (socksPort === 0 && httpPort === 0) {
            console.error(c.red('\n✖ At least one port (SOCKS5 or HTTP) must be specified.'));
            await ask(c.gray('Press Enter to continue...'));
            break;
          }

          const customId = await askTrimmed('Instance ID (optional, press Enter to auto-generate): ');
          if (customId === null) break;
          const id = customId || `${region.toLowerCase()}-${socksPort || httpPort}`;

          try {
            const res = await activeClient.request('add', { id, region, socksPort, httpPort });
            console.log(c.green(`\n✔ ${res.message}`));
          } catch (err) {
            console.error(c.red(`\n✖ Failed to add instance: ${err.message}`));
          }
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '3': {
          const id = await askTrimmed('Enter Instance ID to remove: ');
          if (!id) break;
          const confirm = await askTrimmed(`Are you sure you want to remove "${id}"? (y/N): `);
          if (confirm && (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes')) {
            try {
              const res = await activeClient.request('remove', { id });
              console.log(c.green(`\n✔ ${res.message}`));
            } catch (err) {
              console.error(c.red(`\n✖ Failed: ${err.message}`));
            }
          }
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '4': {
          const id = await askTrimmed('Enter Instance ID to restart: ');
          if (!id) break;
          try {
            const res = await activeClient.request('restart', { id });
            console.log(c.green(`\n✔ ${res.message}`));
          } catch (err) {
            console.error(c.red(`\n✖ Failed: ${err.message}`));
          }
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '5': {
          const confirm = await askTrimmed('Are you sure you want to restart ALL instances? (y/N): ');
          if (confirm && (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes')) {
            try {
              const res = await activeClient.request('restartAll', {}, 30000);
              console.log(c.green(`\n✔ ${res.message}`));
              if (Array.isArray(res.results)) {
                for (const r of res.results) {
                  console.log(`  - ${c.bold(r.id)}: ${r.status}`);
                }
              }
            } catch (err) {
              console.error(c.red(`\n✖ Failed: ${err.message}`));
            }
          }
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '6': {
          const id = await askTrimmed('Enter Instance ID: ');
          if (!id) break;
          const followStr = await askTrimmed('Stream live logs? (y/N): ');
          const follow = followStr && (followStr.toLowerCase() === 'y' || followStr.toLowerCase() === 'yes');

          if (follow) {
            console.log(c.yellow(`\nStreaming logs for "${id}"... (Press Enter or Ctrl+C to return to menu)\n`));
            try {
              let streamActive = true;
              const stream = await activeClient.streamLogs(
                id,
                50,
                (event) => {
                  if (streamActive) {
                    console.log(c.gray(`[${event.timestamp}]`) + ' ' + event.text);
                  }
                },
                () => {
                  if (streamActive) {
                    console.log(c.yellow('\n[INFO] Daemon disconnected.'));
                    streamActive = false;
                  }
                }
              );

              // Print initial lines first
              for (const entry of stream.initialLines) {
                console.log(c.gray(`[${entry.timestamp}]`) + ' ' + entry.text);
              }

              // Flush and start live events
              if (stream.startLive) {
                stream.startLive();
              }

              // Handle SIGINT gracefully during live log streaming (Issue 4.9)
              let stopResolve;
              const stopPromise = new Promise((res) => { stopResolve = res; });

              const sigintHandler = () => {
                if (streamActive) {
                  streamActive = false;
                  stream.close();
                  console.log(c.cyan('\nStopped log streaming. Returning to menu...'));
                  stopResolve();
                }
              };
              process.once('SIGINT', sigintHandler);

              ask('').then(() => {
                if (streamActive) {
                  streamActive = false;
                  stream.close();
                  process.off('SIGINT', sigintHandler);
                  console.log(c.cyan('Stopped log streaming. Returning to menu...'));
                  stopResolve();
                }
              });

              await stopPromise;
              process.off('SIGINT', sigintHandler);
            } catch (err) {
              console.error(c.red(`\n✖ Failed to stream logs: ${err.message}`));
            }
          } else {
            try {
              const res = await activeClient.request('logs', { id, tail: 50 });
              console.log(c.bold(`\nLast logs for "${id}":`));
              for (const entry of res.lines) {
                console.log(c.gray(`[${entry.timestamp}]`) + ' ' + entry.text);
              }
            } catch (err) {
              console.error(c.red(`\n✖ Failed: ${err.message}`));
            }
            await ask(c.gray('Press Enter to continue...'));
          }
          break;
        }

        case '7': {
          const id = await askTrimmed('Enter Instance ID: ');
          if (!id) break;
          const action = await askTrimmed('Action ([start]/stop): ');
          const reqAction = action && action.toLowerCase() === 'stop' ? 'stop' : 'start';
          try {
            const res = await activeClient.request(reqAction, { id });
            console.log(c.green(`\n✔ ${res.message}`));
          } catch (err) {
            console.error(c.red(`\n✖ Failed: ${err.message}`));
          }
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '8': {
          try {
            const doctor = new SystemDoctor();
            await doctor.run();
          } catch (err) {
            console.error(c.red(`Doctor diagnostics failed: ${err.message}`));
          }
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '9': {
          await runUpdate();
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '10': {
          const removed = await runUninstall(askTrimmed, rl);
          if (removed) return;
          await ask(c.gray('Press Enter to continue...'));
          break;
        }

        case '11':
        case '0':
        case 'q':
        case 'exit':
          rl.close();
          console.log(c.cyan('Goodbye!'));
          return;

        default:
          console.log(c.yellow('Invalid choice, please select 1-11.'));
          break;
      }
    }
  };

  try {
    await showMenu();
  } finally {
    if (!rlClosed) {
      rl.close();
    }
  }
}

// Setup Commander CLI
const program = new Command();

program
  .name('psi-ui')
  .description('Psiphon Multi-Instance Management UI and CLI')
  .version('1.0.0');

// Subcommand: doctor (diagnostics and health check)
program
  .command('doctor')
  .description('Run system health check and diagnostics')
  .action(async () => {
    const doctor = new SystemDoctor();
    await doctor.run();
  });

// Subcommand: status / list
program
  .command('status')
  .alias('list')
  .alias('ls')
  .description('Display status of all managed Psiphon instances')
  .action(async () => {
    const client = getClientOrExit();
    try {
      const data = await client.request('status');
      printStatusTable(data);
    } catch (err) {
      console.error(c.red(`[ERROR] Failed to fetch status: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommand: add (supports flags or positional arguments)
program
  .command('add [region] [socks] [http]')
  .description('Add and spawn a new Psiphon instance')
  .option('-r, --region <region>', 'Psiphon egress region code (e.g. DE, US, SG)')
  .option('-s, --socks <port>', 'SOCKS5 local proxy port', parseInt)
  .option('-h, --http <port>', 'HTTP local proxy port', parseInt)
  .option('-i, --id <id>', 'Unique instance identifier (default: <region>-<port>)')
  .action(async (posRegion, posSocks, posHttp, opts) => {
    const client = getClientOrExit();
    const regionRaw = opts.region || posRegion;
    const socksPort = opts.socks !== undefined ? opts.socks : (posSocks ? parseInt(posSocks, 10) : 0);
    const httpPort = opts.http !== undefined ? opts.http : (posHttp ? parseInt(posHttp, 10) : 0);

    if (!regionRaw) {
      console.error(c.red('[ERROR] Region is required.'));
      console.error(c.yellow('Usage: psi-ui add <region> [socksPort] [httpPort]'));
      console.error(c.yellow('   or: psi-ui add -r <region> [-s <socksPort>] [-h <httpPort>] [-i <id>]'));
      process.exit(1);
    }

    if ((!socksPort || socksPort <= 0) && (!httpPort || httpPort <= 0)) {
      console.error(c.red('[ERROR] At least one port (SOCKS5 or HTTP) must be specified.'));
      console.error(c.yellow('Usage examples:'));
      console.error(c.yellow('  psi-ui add DE 2480'));
      console.error(c.yellow('  psi-ui add DE 0 8080'));
      console.error(c.yellow('  psi-ui add -r DE --socks 2480'));
      console.error(c.yellow('  psi-ui add -r DE --http 8080'));
      process.exit(1);
    }

    const region = String(regionRaw).toUpperCase();
    const id = opts.id || `${region.toLowerCase()}-${socksPort || httpPort}`;

    try {
      const res = await client.request('add', { id, region, socksPort, httpPort });
      console.log(c.green(`✔ ${res.message}`));
    } catch (err) {
      console.error(c.red(`[ERROR] Failed to add instance: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommand: remove
program
  .command('remove <id>')
  .alias('rm')
  .description('Stop and remove an instance from configuration')
  .action(async (id) => {
    const client = getClientOrExit();
    try {
      const res = await client.request('remove', { id });
      console.log(c.green(`✔ ${res.message}`));
    } catch (err) {
      console.error(c.red(`[ERROR] Failed to remove instance: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommand: restart
program
  .command('restart <id>')
  .description('Restart a specific instance child process (or "all")')
  .action(async (id) => {
    const client = getClientOrExit();
    if (id.toLowerCase() === 'all') {
      try {
        const res = await client.request('restartAll', {}, 30000);
        console.log(c.green(`✔ ${res.message}`));
        if (Array.isArray(res.results)) {
          for (const r of res.results) {
            console.log(`  - ${c.bold(r.id)}: ${r.status}`);
          }
        }
      } catch (err) {
        console.error(c.red(`[ERROR] Failed to restart instances: ${err.message}`));
        process.exit(1);
      }
      return;
    }

    try {
      const res = await client.request('restart', { id });
      console.log(c.green(`✔ ${res.message}`));
    } catch (err) {
      console.error(c.red(`[ERROR] Failed to restart instance: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommand: restart-all
program
  .command('restart-all')
  .description('Restart all active Psiphon instances')
  .action(async () => {
    const client = getClientOrExit();
    try {
      const res = await client.request('restartAll', {}, 30000);
      console.log(c.green(`✔ ${res.message}`));
      if (Array.isArray(res.results)) {
        for (const r of res.results) {
          console.log(`  - ${c.bold(r.id)}: ${r.status}`);
        }
      }
    } catch (err) {
      console.error(c.red(`[ERROR] Failed to restart instances: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommand: logs
program
  .command('logs <id>')
  .description('View or stream logs for an instance')
  .option('-f, --follow', 'Stream live logs in real time')
  .option('-n, --tail <lines>', 'Number of lines to show from buffer', parseInt, 50)
  .action(async (id, opts) => {
    const client = getClientOrExit();

    if (opts.follow) {
      console.log(c.yellow(`Streaming live logs for "${id}" (Press Ctrl+C to exit)...\n`));
      try {
        const stream = await client.streamLogs(
          id,
          opts.tail,
          (event) => {
            console.log(c.gray(`[${event.timestamp}]`) + ' ' + event.text);
          },
          () => {
            console.log(c.yellow('\n[INFO] Daemon disconnected. Log stream ended.'));
            process.exit(0);
          }
        );

        // Print initial lines in exact chronological order first
        for (const entry of stream.initialLines) {
          console.log(c.gray(`[${entry.timestamp}]`) + ' ' + entry.text);
        }

        // Flush and begin live updates
        if (stream.startLive) {
          stream.startLive();
        }

        process.on('SIGINT', () => {
          stream.close();
          console.log(c.yellow('\nStopped live streaming.'));
          process.exit(0);
        });
      } catch (err) {
        console.error(c.red(`[ERROR] Failed to stream logs: ${err.message}`));
        process.exit(1);
      }
    } else {
      try {
        const res = await client.request('logs', { id, tail: opts.tail });
        for (const entry of res.lines) {
          console.log(c.gray(`[${entry.timestamp}]`) + ' ' + entry.text);
        }
      } catch (err) {
        console.error(c.red(`[ERROR] Failed to fetch logs: ${err.message}`));
        process.exit(1);
      }
    }
  });

// Subcommand: start
program
  .command('start <id>')
  .description('Start a stopped instance')
  .action(async (id) => {
    const client = getClientOrExit();
    try {
      const res = await client.request('start', { id });
      console.log(c.green(`✔ ${res.message}`));
    } catch (err) {
      console.error(c.red(`[ERROR] Failed to start instance: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommand: stop
program
  .command('stop <id>')
  .description('Stop a running instance')
  .action(async (id) => {
    const client = getClientOrExit();
    try {
      const res = await client.request('stop', { id });
      console.log(c.green(`✔ ${res.message}`));
    } catch (err) {
      console.error(c.red(`[ERROR] Failed to stop instance: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommand: update
program
  .command('update')
  .description('Pull latest changes from repository and restart service')
  .action(async () => {
    await runUpdate();
  });

// Subcommand: uninstall
program
  .command('uninstall')
  .description('Uninstall and remove Psiphon Multi Manager and systemd service')
  .action(async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askTrimmed = (q) => new Promise((res) => rl.question(q, (a) => res(a ? a.trim() : '')));
    await runUninstall(askTrimmed, rl);
  });

// If executed directly from command line
if (require.main === module) {
  if (process.argv.length <= 2) {
    const client = getClientOrExit(process.cwd(), false);
    runInteractiveMenu(client).catch((err) => {
      console.error(c.red(`[ERROR] ${err.message}`));
      process.exit(1);
    });
  } else {
    program.parse(process.argv);
  }
}
