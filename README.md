# Psiphon Multi Manager

A simple and reliable tool to run and manage multiple Psiphon tunnels on different ports and regions across Linux systems, featuring an interactive terminal UI (`psi-ui`) and automatic systemd service.

> 🌐 **Language:** English | [🇮🇷 راهنمای فارسی (Persian)](./README.fa_IR.md)

---

## ⚡ 1-Line Quick Installation (Linux)

Run the following command as root to automatically install Node.js (native binary), download the official Psiphon binary into `bin/`, register the systemd service, and configure the `psi-ui` global command:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/Mohammadgb0078/Psiphon-Manager/main/install.sh)
```

*(If you already cloned the repository locally, simply run: `sudo bash install.sh`)*

---

## 🚀 Quick Start with `psi-ui`

Once installed, simply type:

```bash
psi-ui
```

This launches the interactive terminal interface:

```text
═══════════════ Psiphon Manager (psi-ui) ═══════════════
 [1] View Instances Status
 [2] Add New Instance
 [3] Remove Instance
 [4] Restart Instance
 [5] Restart All Instances
 [6] View / Follow Logs
 [7] Start / Stop Instance
 [8] Doctor (Diagnostics & Health Check)
 [9] Exit
─────────────────────────────────────────────────────────
Select an option (1-9):
```

---

## 🩺 System Doctor (`psi-ui doctor`)

Diagnose your entire system health, service status, crash detection, and proxy listeners in one step:

```bash
psi-ui doctor
```

```text
═══════════════════ Psiphon Doctor Diagnostics ═══════════════════
  ✔ Node.js Runtime — v24.21.0 at /usr/local/bin/node
  ✔ NPM Package Manager — v11.6.2
  ✔ Systemd Service Status — active (running) [psiphon-manager.service]
  ✔ Service Auto-Start on Boot — enabled
  ✔ Daemon Process & IPC — Running with PID 18492 on socket /tmp/psiphon-manager.sock
  ✔ Supervisor Overall Uptime — 2h 15m (Daemon PID: 18492)
  ✔ Tunnel Instances Summary — 2 total (2 connected)
    Instance "de-2478" [DE] — ● ACTIVE | SOCKS:2478 | uptime: 2h 14m
    Instance "us-2479" [US] — ● ACTIVE | SOCKS:2479 | uptime: 2h 14m
───────────────────────────────────────────────────────────────────
  ✔ All diagnostic checks passed! System is operating normally.
═══════════════════════════════════════════════════════════════════
```

> **Stale Lock / Crash Detection:** If your server experiences sudden power loss or an ungraceful shutdown, Doctor automatically detects dead PIDs and cleans stale locks.

---

## Direct CLI Commands

```bash
# View live instances status table
psi-ui status

# Add a new instance (<Region> <SocksPort>)
psi-ui add US 2479

# View or stream live logs in real time
psi-ui logs de-2478 -f

# Restart an instance / Restart all instances
psi-ui restart de-2478
psi-ui restart all

# Temporarily stop / start an instance
psi-ui stop de-2478
psi-ui start de-2478

# Remove an instance
psi-ui remove de-2478
```

<details>
<summary><b>📖 Advanced CLI Flags & Options</b></summary>

<br>

```bash
# Add instance with custom HTTP port and custom ID
psi-ui add --region SG --socks 2480 --http 8080 --id sg-custom

# Fetch custom line count of historical logs without streaming
psi-ui logs de-2478 --tail 100
```

</details>

---

## System Service Control (`systemctl`)

```bash
# Check service status:
sudo systemctl status psiphon-manager

# View live systemd daemon logs:
sudo journalctl -u psiphon-manager -f

# Restart / Stop service:
sudo systemctl restart psiphon-manager
sudo systemctl stop psiphon-manager
```

---

## Supported Egress Regions (26 Countries)

<details>
<summary><b>🌍 Click to expand the full table of 26 supported countries and codes</b></summary>

<br>

| Flag | ISO Code | Country Name |
| :---: | :---: | :--- |
| 🇦🇹 | `AT` | Austria |
| 🇦🇺 | `AU` | Australia |
| 🇧🇪 | `BE` | Belgium |
| 🇨🇦 | `CA` | Canada |
| 🇨🇭 | `CH` | Switzerland |
| 🇨🇿 | `CZ` | Czech Republic |
| 🇩🇪 | `DE` | Germany |
| 🇩🇰 | `DK` | Denmark |
| 🇪🇸 | `ES` | Spain |
| 🇫🇮 | `FI` | Finland |
| 🇫🇷 | `FR` | France |
| 🇬🇧 | `GB` | United Kingdom |
| 🇮🇩 | `ID` | Indonesia |
| 🇮🇪 | `IE` | Ireland |
| 🇮🇳 | `IN` | India |
| 🇮🇹 | `IT` | Italy |
| 🇯🇵 | `JP` | Japan |
| 🇱🇹 | `LT` | Lithuania |
| 🇳🇱 | `NL` | Netherlands |
| 🇳🇴 | `NO` | Norway |
| 🇵🇱 | `PL` | Poland |
| 🇷🇴 | `RO` | Romania |
| 🇷🇸 | `RS` | Serbia |
| 🇸🇪 | `SE` | Sweden |
| 🇸🇬 | `SG` | Singapore |
| 🇺🇸 | `US` | United States |

</details>

---

## Configuration Details (`config.json`)

<details>
<summary><b>⚙️ Click to view sample config.json & auto-import mechanism</b></summary>

<br>

If `/etc/psiphon/core.config` exists on your server, the manager **automatically reads** the base parameters (`RemoteServerListUrl`, `RemoteServerListSignaturePublicKey`, `SponsorId`, etc.) from it:

```json
{
  "binaryPath": "./bin/psiphon-tunnel-core-x86_64",
  "baseConfigFile": "/etc/psiphon/core.config",
  "baseConfig": {
    "PropagationChannelId": "FFFFFFFFFFFFFFFF",
    "SponsorId": "FFFFFFFFFFFFFFFF",
    "RemoteServerListUrl": "https://s3.amazonaws.com//psiphon/web/mjr4-p23r-puwl/server_list_compressed",
    "RemoteServerListDownloadFilename": "remote_server_list",
    "RemoteServerListSignaturePublicKey": "MIICIDANBgkqhkiG9w0BAQEFAAOCAg0AMIICCAKCAgEAt7Ls+/39r+T6zNW7GiVpJfzq/xvL9SBH5rIFnk0RXYEYavax3WS6HOD35eTAqn8An...",
    "UseIndistinguishableTLS": true
  },
  "instances": []
}
```

</details>

---

## Compiling Core from Source (Optional)

<details>
<summary><b>🛠️ How to Compile Cross-Platform with Go (Linux, ARM, Windows, macOS)</b></summary>

<br>

The installer automatically downloads the official pre-built binary. If you prefer to compile yourself:

```bash
git clone https://github.com/Psiphon-Labs/psiphon-tunnel-core.git
cd psiphon-tunnel-core/ConsoleClient

# 1. Linux x86_64:
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o psiphon-tunnel-core-x86_64

# 2. Linux ARM64:
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o psiphon-tunnel-core-arm64
```

</details>

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Mohammadgb0078/Psiphon-Manager&type=Date)](https://star-history.com/#Mohammadgb0078/Psiphon-Manager&Date)

---

## License

This project is licensed under the [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) - matching the open-source licensing of Psiphon Tunnel Core.

---

<p align="center">
  ✨ <i>Fully VibeCoded Using Gemini</i>
</p>
