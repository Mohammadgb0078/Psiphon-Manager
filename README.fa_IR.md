# Psiphon Multi Manager

ابزار ساده، سبک و پایدار برای اجرای همزمان چندین تونل سایفون روی پورت‌ها و ریجن‌های مختلف در سرورهای لینوکس، به همراه منوی تعاملی ترمینال (`psi-ui`) و سرویس پس‌زمینه خودکار systemd.

> 🌐 **زبان / Language:** [🇬🇧 English Documentation](./README.md) | فارسی

---

## ⚡ نصب سریع تک‌خطی (Quick Installation)

کافیست دستور زیر را با دسترسی روت در ترمینال سرور لینوکس خود اجرا کنید تا نود جی‌اس به صورت Native نصب شده، باینری رسمی سایفون دانلود شده، سرویس رجیستر شود و دستور `psi-ui` در دسترس قرار گیرد:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/Mohammadgb0078/Psiphon-Manager/main/install.sh)
```

*(در صورتی که سورس پروژه را از قبل روی سرور کلون کرده‌اید، فقط دستور `sudo bash install.sh` را اجرا کنید)*

---

## 🚀 شروع سریع با دستور `psi-ui`

پس از اتمام نصب، در هر کجای سرور که هستید کافیست تایپ کنید:

```bash
psi-ui
```

منوی تعاملی و زیبا باز می‌شود:

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

## 🩺 ابزار عیب‌یابی و بررسی سلامت سیستم (`psi-ui doctor`)

با اجرای گزینه `Doctor` یا دستور مستقیم `psi-ui doctor`، تمام اجزای سیستم، سرویس‌ها، پورت‌ها و قطعی‌های احتمالی برق سرور به صورت گام‌به‌گام بررسی می‌شوند:

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

> **تشخیص هوشمند Stale Lock / قطعی برق سرور:** اگر برق سرور ناگهان برود یا پروسه فورس‌کیل شود، بخش Doctor زنده بودن PID را چک می‌کند و خرابی فایل قفل را اعلام و پاکسازی می‌کند.

---

## دستورات مستقیم خط فرمان

```bash
# مشاهده جدول وضعیت زنده پروسه‌ها:
psi-ui status

# افزودن اینستنس جدید (<Region> <SocksPort>):
psi-ui add US 2479

# مشاهده و استریم زنده لاگ‌ها:
psi-ui logs de-2478 -f

# ریستارت یک پروسه یا تمام پروسه‌ها:
psi-ui restart de-2478
psi-ui restart all

# توقف / شروع موقت یک اینستنس:
psi-ui stop de-2478
psi-ui start de-2478

# حذف یک پروسه:
psi-ui remove de-2478
```

<details>
<summary><b>📖 سوییچ‌ها و دستورات پیشرفته‌تر CLI</b></summary>

<br>

```bash
# افزودن با پورت سفارشی HTTP و نام دلخواه ID:
psi-ui add -r SG -s 2480 -h 8080 -i sg-custom

# مشاهده تعداد خطوط بیشتر لاگ در گذشته (بدون استریم زنده):
psi-ui logs de-2478 --tail 100
```

</details>

---

## مدیریت سرویس در سطح سیستم‌عامل (`systemctl`)

```bash
# بررسی وضعیت اجرای سرویس:
sudo systemctl status psiphon-manager

# مشاهده زنده لاگ‌های سرویس در journalctl:
sudo journalctl -u psiphon-manager -f

# ریستارت یا متوقف کردن سرویس:
sudo systemctl restart psiphon-manager
sudo systemctl stop psiphon-manager
```

---

## جدول ۲۶ کشور پشتیبانی‌شده (Egress Regions)

<details>
<summary><b>🌍 برای مشاهده جدول کامل ۲۶ کشور و کدهای رسمی کلیک کنید</b></summary>

<br>

| پرچم | کد کشور | نام کشور (انگلیسی) | نام کشور (فارسی) |
| :---: | :---: | :--- | :--- |
| 🇦🇹 | `AT` | Austria | اتریش |
| 🇦🇺 | `AU` | Australia | استرالیا |
| 🇧🇪 | `BE` | Belgium | بلژیک |
| 🇨🇦 | `CA` | Canada | کانادا |
| 🇨🇭 | `CH` | Switzerland | سوئیس |
| 🇨🇿 | `CZ` | Czech Republic | جمهوری چک |
| 🇩🇪 | `DE` | Germany | آلمان |
| 🇩🇰 | `DK` | Denmark | دانمارک |
| 🇪🇸 | `ES` | Spain | اسپانیا |
| 🇫🇮 | `FI` | Finland | فنلاند |
| 🇫🇷 | `FR` | France | فرانسه |
| 🇬🇧 | `GB` | United Kingdom | بریتانیا |
| 🇮🇩 | `ID` | Indonesia | اندونزی |
| 🇮🇪 | `IE` | Ireland | ایرلند |
| 🇮🇳 | `IN` | India | هند |
| 🇮🇹 | `IT` | Italy | ایتالیا |
| 🇯🇵 | `JP` | Japan | ژاپن |
| 🇱🇹 | `LT` | Lithuania | لیتوانی |
| 🇳🇱 | `NL` | Netherlands | هلند |
| 🇳🇴 | `NO` | Norway | نروژ |
| 🇵🇱 | `PL` | Poland | لهستان |
| 🇷🇴 | `RO` | Romania | رومانی |
| 🇷🇸 | `RS` | Serbia | صربستان |
| 🇸🇪 | `SE` | Sweden | سوئد |
| 🇸🇬 | `SG` | Singapore | سنگاپور |
| 🇺🇸 | `US` | United States | ایالات متحده آمریکا |

</details>

---

## تنظیمات پیش‌فرض و ادغام خودکار (`config.json`)

<details>
<summary><b>⚙️ مشاهده نمونه کامل فایل config.json</b></summary>

<br>

اگر فایل `/etc/psiphon/core.config` روی سرور شما وجود داشته باشد، سیستم به صورت خودکار پارامترهای پایه را از آن لود می‌کند:

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

## نمودار ستاره‌ها (Star History)

[![Star History Chart](https://api.star-history.com/svg?repos=Mohammadgb0078/Psiphon-Manager&type=Date)](https://star-history.com/#Mohammadgb0078/Psiphon-Manager&Date)

---

## لایسنس

این پروژه تحت لایسنس [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) منتشر شده است که کاملاً منطبق با ساختار لایسنس رسمی پروژه Psiphon Tunnel Core می‌باشد.

---

<p align="center">
  ✨ <i>Fully VibeCoded Using Gemini</i>
</p>
