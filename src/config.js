/**
 * Configuration Manager & Validator
 */
const fs = require('fs');
const path = require('path');
const { ALLOWED_REGIONS } = require('./constants');

const ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

/**
 * Validate a single instance definition
 */
function validateInstance(inst, existingInstances = [], currentIndex = -1) {
  if (!inst || typeof inst !== 'object') {
    throw new Error('Instance must be an object');
  }

  // ID validation
  if (!inst.id || typeof inst.id !== 'string') {
    throw new Error('Instance "id" is required and must be a string');
  }
  const trimmedId = inst.id.trim();
  if (!ID_REGEX.test(trimmedId)) {
    throw new Error(`Instance ID "${inst.id}" contains invalid characters. Use alphanumeric, dash, and underscore.`);
  }

  // Region validation
  if (!inst.region || typeof inst.region !== 'string') {
    throw new Error(`Instance "${inst.id}": "region" is required.`);
  }
  const upperRegion = inst.region.trim().toUpperCase();
  if (!ALLOWED_REGIONS.includes(upperRegion)) {
    throw new Error(
      `Instance "${inst.id}": Region "${inst.region}" is not supported. Supported regions: ${ALLOWED_REGIONS.join(', ')}`
    );
  }

  // Port validation: At least one port (SOCKS or HTTP) must be configured
  if (typeof inst.socksPort === 'boolean' || typeof inst.httpPort === 'boolean') {
    throw new Error(`Instance "${inst.id}": Port values cannot be boolean`);
  }

  const socksPort = inst.socksPort !== undefined && inst.socksPort !== null ? Number(inst.socksPort) : 0;
  const httpPort = inst.httpPort !== undefined && inst.httpPort !== null ? Number(inst.httpPort) : 0;

  if (socksPort === 0 && httpPort === 0) {
    throw new Error(`Instance "${inst.id}": At least one port (SOCKS or HTTP) must be configured.`);
  }

  if (socksPort !== 0 && (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535)) {
    throw new Error(`Instance "${inst.id}": socksPort must be an integer between 1 and 65535. Received: ${inst.socksPort}`);
  }

  if (httpPort !== 0 && (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535)) {
    throw new Error(`Instance "${inst.id}": httpPort must be an integer between 1 and 65535. Received: ${inst.httpPort}`);
  }

  // Enabled flag
  const enabled = inst.enabled !== false;

  // Same-instance SOCKS vs HTTP collision check
  if (socksPort > 0 && httpPort > 0 && httpPort === socksPort) {
    throw new Error(`Port collision: SOCKS port and HTTP port cannot be the same (${socksPort}) on instance "${inst.id}"`);
  }

  // Collision checks with existing instances
  for (let i = 0; i < existingInstances.length; i++) {
    if (i === currentIndex) continue;
    const other = existingInstances[i];

    if (other.id.toLowerCase() === trimmedId.toLowerCase()) {
      throw new Error(`Duplicate instance ID found: "${trimmedId}"`);
    }

    if (socksPort > 0 && other.socksPort === socksPort) {
      throw new Error(`Port collision: SOCKS port ${socksPort} is already used by instance "${other.id}"`);
    }

    if (httpPort > 0) {
      if (other.httpPort > 0 && other.httpPort === httpPort) {
        throw new Error(`Port collision: HTTP port ${httpPort} is already used by instance "${other.id}"`);
      }
      if (other.socksPort === httpPort) {
        throw new Error(`Port collision: HTTP port ${httpPort} collides with SOCKS port of instance "${other.id}"`);
      }
    }

    if (socksPort > 0 && other.httpPort > 0 && other.httpPort === socksPort) {
      throw new Error(`Port collision: SOCKS port ${socksPort} collides with HTTP port of instance "${other.id}"`);
    }
  }

  return {
    id: trimmedId,
    region: upperRegion,
    socksPort,
    httpPort,
    enabled
  };
}

/**
 * Validate the entire configuration object
 */
function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Configuration must be a valid JSON object');
  }

  const binaryPath = config.binaryPath || './bin/psiphon-tunnel-core-x86_64';
  if (typeof binaryPath !== 'string') {
    throw new Error('binaryPath must be a string path');
  }

  const baseConfigFile = typeof config.baseConfigFile === 'string' ? config.baseConfigFile : null;

  if (!config.baseConfig || typeof config.baseConfig !== 'object') {
    throw new Error('baseConfig must be an object with Psiphon core parameters');
  }

  if (!Array.isArray(config.instances)) {
    throw new Error('instances must be an array of instance configurations');
  }

  const validatedInstances = [];
  for (let i = 0; i < config.instances.length; i++) {
    const validated = validateInstance(config.instances[i], validatedInstances, -1);
    validatedInstances.push(validated);
  }

  const result = {
    binaryPath,
    baseConfig: { ...config.baseConfig },
    instances: validatedInstances
  };

  if (baseConfigFile) {
    result.baseConfigFile = baseConfigFile;
  }

  return result;
}

/**
 * Load configuration from file, merging external baseConfigFile if present
 */
function loadConfig(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Configuration file not found at: ${resolved}`);
  }

  let content;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read config file: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON syntax in config file: ${err.message}`);
  }

  // If baseConfigFile is specified or default /etc/psiphon-manager/core.config exists, merge it
  const baseConfigFileCandidate = parsed.baseConfigFile || (
    process.platform !== 'win32' && fs.existsSync('/etc/psiphon-manager/core.config') ? '/etc/psiphon-manager/core.config' : null
  );

  if (baseConfigFileCandidate) {
    const baseResolved = path.isAbsolute(baseConfigFileCandidate)
      ? baseConfigFileCandidate
      : path.resolve(path.dirname(resolved), baseConfigFileCandidate);
    if (fs.existsSync(baseResolved)) {
      try {
        const rawBase = fs.readFileSync(baseResolved, 'utf8');
        const parsedBase = JSON.parse(rawBase);
        // Exclude instance-specific fields
        delete parsedBase.LocalHttpProxyPort;
        delete parsedBase.LocalSocksProxyPort;
        delete parsedBase.EgressRegion;
        delete parsedBase.DataStoreDirectory;
        delete parsedBase.DataRootDirectory;
        // Merge with preference to user-specified baseConfig overrides
        parsed.baseConfig = { ...parsedBase, ...(parsed.baseConfig || {}) };
        if (!parsed.baseConfigFile) {
          parsed.baseConfigFile = baseConfigFileCandidate;
        }
      } catch (err) {
        console.warn(`[WARN] Failed to load external baseConfigFile at ${baseResolved}: ${err.message}`);
      }
    }
  }

  return validateConfig(parsed);
}

/**
 * Save configuration to file atomically with fsync and secure permissions
 */
function saveConfig(filePath, config) {
  const validated = validateConfig(config);
  const resolved = path.resolve(filePath);
  const tempPath = `${resolved}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  const jsonStr = JSON.stringify(validated, null, 2);

  // Ensure directory exists
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    const fd = fs.openSync(tempPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, jsonStr, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, resolved);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
    throw err;
  }

  return validated;
}

/**
 * Merge base config and instance parameters to generate individual Psiphon config.
 * Guarantees total filesystem isolation by setting DataRootDirectory and DataStoreDirectory.
 */
function generateInstanceConfig(baseConfig, instance, dataDir) {
  const resolvedDataDir = path.resolve(dataDir);
  const cfg = {
    ...baseConfig,
    LocalSocksProxyPort: instance.socksPort,
    LocalHttpProxyPort: instance.httpPort || 0,
    EgressRegion: instance.region,
    DataRootDirectory: resolvedDataDir,
    DataStoreDirectory: resolvedDataDir
  };

  return cfg;
}

module.exports = {
  validateInstance,
  validateConfig,
  loadConfig,
  saveConfig,
  generateInstanceConfig,
  ALLOWED_REGIONS
};
