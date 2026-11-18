#!/usr/bin/env bash
# ==============================================================================
# Psiphon Multi-Instance Manager - Automated Installer
# Supported OS: Ubuntu 24.04 / 22.04 / Debian 11+ / RHEL-based Linux
# ==============================================================================

set -e

# ANSI Color formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "\n${BOLD}${CYAN}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYAN}       Psiphon Multi-Instance Manager - Automated Installer       ${NC}"
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════════════════${NC}\n"

# 1. Verify Root Privileges
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] This installer must be run as root.${NC}"
  echo -e "${YELLOW}Please re-run using:${NC} sudo bash $0"
  exit 1
fi

# 2. Configuration & Target Paths
INSTALL_DIR="/etc/psiphon-manager"
SERVICE_NAME="psiphon-manager"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CLI_SYMLINK="/usr/local/bin/psi-ui"
NODE_TARGET_VERSION="24.21.0"
PSIPHON_BIN_URL="https://github.com/Psiphon-Labs/psiphon-tunnel-core-binaries/raw/refs/heads/master/linux/psiphon-tunnel-core-x86_64"
DEFAULT_REPO_URL="https://github.com/Mohammadgb0078/Psiphon-Manager"

# 3. Detect Architecture
ARCH="$(uname -m)"
echo -e "${BLUE}▶ Checking system architecture...${NC}"
if [ "$ARCH" != "x86_64" ]; then
  echo -e "${YELLOW}[WARN] Official pre-built Psiphon binary is for x86_64. Current architecture is: ${ARCH}${NC}"
fi
echo -e "  ${GREEN}✔ Architecture: ${ARCH}${NC}"

# 4. Install essential Linux utilities (curl, tar, xz, git)
echo -e "\n${BLUE}▶ Checking and installing required system packages...${NC}"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y -qq
  apt-get install -y -qq curl tar xz-utils git ca-certificates >/dev/null 2>&1
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q curl tar xz git ca-certificates >/dev/null 2>&1
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q curl tar xz git ca-certificates >/dev/null 2>&1
fi
echo -e "  ${GREEN}✔ Essential utilities installed (curl, tar, xz, git)${NC}"

# 5. Check & Install Native Node.js Binary
echo -e "\n${BLUE}▶ Verifying Node.js environment (Target: v${NODE_TARGET_VERSION})...${NC}"
INSTALL_NODE=false

if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_VER="$(node -v | sed 's/^v//')"
  CURRENT_MAJOR="$(echo "$CURRENT_NODE_VER" | cut -d. -f1)"
  TARGET_MAJOR="$(echo "$NODE_TARGET_VERSION" | cut -d. -f1)"
  
  if [ "$CURRENT_MAJOR" -lt "$TARGET_MAJOR" ] && [ "$CURRENT_MAJOR" -lt 20 ]; then
    echo -e "  ${YELLOW}Installed Node.js (v${CURRENT_NODE_VER}) is outdated. Installing native v${NODE_TARGET_VERSION}...${NC}"
    INSTALL_NODE=true
  else
    echo -e "  ${GREEN}✔ Node.js already present: v${CURRENT_NODE_VER}${NC}"
  fi
else
  echo -e "  Node.js not detected. Installing native Node.js v${NODE_TARGET_VERSION}..."
  INSTALL_NODE=true
fi

if [ "$INSTALL_NODE" = true ]; then
  NODE_TARBALL_URL="https://nodejs.org/dist/v${NODE_TARGET_VERSION}/node-v${NODE_TARGET_VERSION}-linux-x64.tar.xz"
  echo -e "  Downloading Node.js from: ${CYAN}${NODE_TARBALL_URL}${NC}"
  
  TMP_NODE_TAR="$(mktemp /tmp/node-tar.XXXXXX)"
  curl -fsSL "$NODE_TARBALL_URL" -o "$TMP_NODE_TAR"
  
  mkdir -p /usr/local/node
  tar -xJf "$TMP_NODE_TAR" -C /usr/local/node --strip-components=1
  rm -f "$TMP_NODE_TAR"
  
  # Symlink to /usr/local/bin
  ln -sf /usr/local/node/bin/node /usr/local/bin/node
  ln -sf /usr/local/node/bin/npm /usr/local/bin/npm
  ln -sf /usr/local/node/bin/npx /usr/local/bin/npx
  
  # Global PATH persistence:
  # 1. /etc/profile.d/node.sh (modern standard for all users and login shells)
  echo 'export PATH=$PATH:/usr/local/node/bin' > /etc/profile.d/node.sh
  chmod +x /etc/profile.d/node.sh

  # 2. Add to /etc/profile as fallback
  if ! grep -q "/usr/local/node/bin" /etc/profile; then
    echo 'export PATH=$PATH:/usr/local/node/bin' >> /etc/profile
  fi

  # 3. Export to current installer session
  export PATH=$PATH:/usr/local/node/bin
fi

NODE_VER_CHECK="$(node -v)"
NPM_VER_CHECK="$(npm -v)"
echo -e "  ${GREEN}✔ Node.js runtime active: ${NODE_VER_CHECK} at $(which node)${NC}"
echo -e "  ${GREEN}✔ NPM package manager: v${NPM_VER_CHECK}${NC}"

# 6. Deploy Project Files to /etc/psiphon-manager
echo -e "\n${BLUE}▶ Setting up project in ${INSTALL_DIR}...${NC}"
mkdir -p "$INSTALL_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/src/daemon.js" ] && [ -f "${SCRIPT_DIR}/package.json" ]; then
  # Local installer: copy existing workspace files
  echo -e "  Copying local project files to ${INSTALL_DIR}..."
  cp -r "${SCRIPT_DIR}/"* "$INSTALL_DIR/" 2>/dev/null || true
  cp -r "${SCRIPT_DIR}/".[!.]* "$INSTALL_DIR/" 2>/dev/null || true
else
  # Remote curl installer: clone from git
  echo -e "  Cloning repository into ${INSTALL_DIR}..."
  if [ -d "${INSTALL_DIR}/.git" ]; then
    cd "$INSTALL_DIR"
    git pull --quiet
  else
    # Fallback to current git clone or local files
    git clone --depth 1 "$DEFAULT_REPO_URL" "$INSTALL_DIR"
  fi
fi

# 7. Download Official Psiphon Core Binary into bin/
echo -e "\n${BLUE}▶ Downloading official Psiphon Tunnel Core binary...${NC}"
mkdir -p "${INSTALL_DIR}/bin"
BIN_TARGET="${INSTALL_DIR}/bin/psiphon-tunnel-core-x86_64"

echo -e "  Source: ${CYAN}${PSIPHON_BIN_URL}${NC}"
echo -e "  Target: ${BIN_TARGET}"
curl -fSL --progress-bar "$PSIPHON_BIN_URL" -o "$BIN_TARGET"
chmod +x "$BIN_TARGET"
echo -e "  ${GREEN}✔ Psiphon core binary installed and executable.${NC}"

# 8. Install NPM Dependencies
echo -e "\n${BLUE}▶ Installing project dependencies (npm install)...${NC}"
cd "$INSTALL_DIR"
npm install --omit=dev --silent
echo -e "  ${GREEN}✔ Dependencies installed successfully.${NC}"

# 9. Verify / Initialize Configuration
echo -e "\n${BLUE}▶ Initializing configuration...${NC}"
CONFIG_FILE="${INSTALL_DIR}/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "  Generating default config.json..."
  cat > "$CONFIG_FILE" <<EOF
{
  "binaryPath": "./bin/psiphon-tunnel-core-x86_64",
  "baseConfigFile": "/etc/psiphon-manager/core.config",
  "baseConfig": {
    "PropagationChannelId": "FFFFFFFFFFFFFFFF",
    "SponsorId": "FFFFFFFFFFFFFFFF",
    "RemoteServerListUrl": "https://s3.amazonaws.com//psiphon/web/mjr4-p23r-puwl/server_list_compressed",
    "RemoteServerListDownloadFilename": "remote_server_list",
    "RemoteServerListSignaturePublicKey": "MIICIDANBgkqhkiG9w0BAQEFAAOCAg0AMIICCAKCAgEAt7Ls+/39r+T6zNW7GiVpJfzq/xvL9SBH5rIFnk0RXYEYavax3WS6HOD35eTAqn8An",
    "UseIndistinguishableTLS": true
  },
  "instances": []
}
EOF
fi

# Test dry-run: Verify config syntax and loader
echo -e "  Running dry-run test on configuration..."
DRY_RUN_OUTPUT=$(node -e "
  try {
    const { loadConfig } = require('./src/config');
    loadConfig('./config.json');
    console.log('SUCCESS');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
" 2>&1)

if [ "$DRY_RUN_OUTPUT" != "SUCCESS" ]; then
  echo -e "${RED}[ERROR] Configuration dry-run test failed:${NC}"
  echo -e "${RED}${DRY_RUN_OUTPUT}${NC}"
  exit 1
fi
echo -e "  ${GREEN}✔ Configuration verified successfully.${NC}"

# 10. Install & Register systemd Service
echo -e "\n${BLUE}▶ Setting up systemd service (${SERVICE_NAME}.service)...${NC}"
NODE_PATH_REAL="$(which node)"
SERVICE_TEMPLATE="${INSTALL_DIR}/systemd/psiphon-manager.service"

sed -e "s|%WORKING_DIR%|${INSTALL_DIR}|g" \
    -e "s|%NODE_PATH%|${NODE_PATH_REAL}|g" \
    "$SERVICE_TEMPLATE" > "$SERVICE_FILE"

chmod 644 "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service" --quiet
systemctl restart "${SERVICE_NAME}.service"
echo -e "  ${GREEN}✔ Service ${SERVICE_NAME}.service registered and started.${NC}"

# 11. Create global 'psi-ui' CLI command symlink
echo -e "\n${BLUE}▶ Creating global CLI shortcut (psi-ui)...${NC}"
chmod +x "${INSTALL_DIR}/src/cli.js"
ln -sf "${INSTALL_DIR}/src/cli.js" "$CLI_SYMLINK"
echo -e "  ${GREEN}✔ Linked ${CLI_SYMLINK} -> ${INSTALL_DIR}/src/cli.js${NC}"

# 12. Completion Banner
echo -e "\n${BOLD}${GREEN}✔ Psiphon Multi Manager successfully installed!${NC}"
echo -e "Launch interactive menu: ${BOLD}${CYAN}psi-ui${NC}"
echo -e "Run diagnostics:         ${BOLD}psi-ui doctor${NC}\n"
