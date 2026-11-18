/**
 * System constants for Psiphon Multi-Instance Manager
 */
const path = require('path');
const os = require('os');

// Official supported regions specified by Psiphon / user request
const ALLOWED_REGIONS = [
  'AT', 'AU', 'BE', 'CA', 'CH', 'CZ', 'DE', 'DK', 'ES', 'FI',
  'FR', 'GB', 'ID', 'IE', 'IN', 'IT', 'JP', 'LT', 'NL', 'NO',
  'PL', 'RO', 'RS', 'SE', 'SG', 'US'
];

// Instance lifecycle status constants
const INSTANCE_STATUS = {
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR'
};

const LOCK_FILE_NAME = 'cli.lock';
const DEFAULT_CONFIG_FILE = 'config.json';

/**
 * Returns default IPC socket/pipe path based on operating system
 */
function getDefaultSocketPath(projectDir) {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\psiphon-manager-ipc';
  }
  // On Unix/Linux, use /tmp or project-specific socket in /tmp
  return path.join('/tmp', 'psiphon-manager.sock');
}

/**
 * Returns centralized candidate locations for cli.lock
 */
function getLockCandidates(projectDir) {
  const candidates = [];
  if (projectDir) {
    candidates.push(path.resolve(projectDir, LOCK_FILE_NAME));
  }
  candidates.push(path.resolve(process.cwd(), LOCK_FILE_NAME));
  candidates.push(path.resolve(__dirname, '..', LOCK_FILE_NAME));
  if (process.platform !== 'win32') {
    candidates.push(path.join('/tmp', 'psiphon-cli.lock'));
    candidates.push(path.join('/etc/psiphon-manager', LOCK_FILE_NAME));
    candidates.push(path.join('/var/run/psiphon-manager', LOCK_FILE_NAME));
  } else {
    candidates.push(path.join(os.tmpdir(), 'psiphon-cli.lock'));
  }
  return [...new Set(candidates)];
}

module.exports = {
  ALLOWED_REGIONS,
  INSTANCE_STATUS,
  LOCK_FILE_NAME,
  DEFAULT_CONFIG_FILE,
  getDefaultSocketPath,
  getLockCandidates
};
