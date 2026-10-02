# Process Control V2

> Desktop application for multi-sensor laboratory process control, with built-in browser access for tablets and phones on the same network — built by Matrix TSL.

**Version:** `0.1.9` &nbsp;|&nbsp; **Platform:** Windows (Electron desktop) &nbsp;|&nbsp; **License:** MIT

> **Status: Stable** — Hardware auto-routing + landing page. Supports Temperature, Pressure, Flow, Level, Servo Speed, and Servo Angle sensor pages. Temperature uses `renderer.js`; the other hardware pages share `renderer-hardware.js`.

---

## Overview

This app connects to a hardware process controller over Serial or USB HID and provides:

- Real-time monitoring and control across six sensor types
- Three control modes on every sensor page: **Manual**, **On/Off**, and **PID**
- Live dual-canvas charting (process variable + output/PID terms)
- Admin panel with logs, bootloader, and firmware update tools
- **Primary deployment:** Electron desktop app — installed on the lab PC with hardware connected
- **Tablet / phone access:** built-in embedded server starts automatically with the desktop app; scan the QR code to open the full UI in any browser on the same network — no installation needed on the tablet
- **Headless server mode** (`npm run web`) — for lab PCs or Raspberry Pi where no GUI is needed; still requires Node.js + hardware physically connected to the host machine
- Live SSE data stream — hardware data pushed to all connected browsers in real time
- **Hardware auto-routing** — app reads `{A: X}` hardware ID on connect and auto-navigates to the matching sensor page

---

## Screenshots

![Process Control App Dashboard](assets/PID%20app%20image.png)

---

## Quick Start

```bash
npm install        # install dependencies
npm run web        # run as web server → http://localhost:3000
npm start          # run as Electron desktop app
```

> **Note:** There is a pre-existing `electron-updater` crash on `npm start`. Use `npm run web` to test UI changes in a browser.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm start` | Run Electron desktop app |
| `npm run dev` | Run Electron in developer mode |
| `npm run web` | Run as Express web server (port 3000) |
| `npm run web-dev` | Web server with nodemon auto-reload |
| `npm run build` | Build desktop app (default target) |
| `npm run build-win` | Build Windows NSIS installer |
| `npm run build-all` | Build for Windows, macOS, and Linux |
| `npm run rebuild-hid` | Rebuild `node-hid` native bindings |

---

## Sensor Pages

The app opens a landing page on startup and auto-navigates to the correct sensor page based on the `{A: X}` hardware ID broadcast. Six sensor types are supported:

| Hardware ID | Page | Sensor | Unit |
|-------------|------|--------|------|
| 201 | [index.html](index.html) | Temperature | °C / °F |
| 202 | [pressure.html](pressure.html) | Pressure | (configured per device) |
| 203 | [level.html](level.html) | Level | (configured per device) |
| 204 | [flow.html](flow.html) | Flow | (configured per device) |
| 205 | [servo-speed.html](servo-speed.html) | Servo Speed | RPM (0–60) |
| 206 | [servo-angle.html](servo-angle.html) | Servo Angle | ° (−180–180) |

The five non-temperature pages share the same `renderer-hardware.js` engine. Only axis ranges, unit labels, output labels, and sensor-specific controls differ. The temperature page uses `renderer.js`.

---

## Control Modes

All sensor pages support three control modes. Switching modes sends a safety reset to the hardware, resets the visible controls to safe minimum values, and reinitializes the chart.

---

### Manual Mode

Direct open-loop control — the operator sets output values explicitly with no feedback from the sensor.

**How it works:**
- Set the primary output (e.g. heater power, servo drive) with a slider or preset buttons (`0–100%`, or device-specific range)
- Set fan/secondary output independently
- Hardware executes the command immediately; the sensor reading is displayed in real time but does not influence the output

**Chart:**
| Canvas | Dataset |
|--------|---------|
| Primary | Process variable (temperature, speed, angle, etc.) |
| Secondary | Output % |

**Hardware command:** `{C: 1, P: <value>, F: <fan>}`

**Typical use:** commissioning, open-loop characterization, manual override

---

### On/Off Mode

Hysteresis-based two-state control — the hardware switches the actuator fully on or fully off based on a setpoint and a dead-band.

**How it works:**
- Set a **target setpoint** in sensor units (e.g. 20–70 °C, 0–60 RPM, −180°–180°, etc.)
- Set a **hysteresis** band — the dead-band around the setpoint in sensor units
- Hardware turns the actuator **on** when the process variable drops below `setpoint − hysteresis` and **off** when it rises above `setpoint + hysteresis`
- Fan/secondary output is independently controlled

**Parameters:**
| Parameter | Range | Description |
|-----------|-------|-------------|
| Target setpoint | Sensor min–max | Desired process value |
| Hysteresis | 1–10 (device units) | Dead-band around setpoint |
| Fan speed | 0–100 % | Secondary output |

**Chart:**
| Canvas | Dataset |
|--------|---------|
| Primary | Process variable, target line, upper hysteresis band, lower hysteresis band |
| Secondary | Output % |

**Hardware command:** `{C: 2, T: <setpoint>, Y: <hysteresis>, F: <fan>}`

**Typical use:** simple regulators, on/off valve control, bang-bang level or speed control

---

### PID Mode

Closed-loop proportional–integral–derivative control — the hardware computes a continuous output signal that drives the process variable to the setpoint.

**How it works:**
- Set a **target setpoint**
- Configure **P**, **I**, and **D** gains individually
- The app uses the full **PID** controller for every product
- Set a **PID frequency** (update rate sent to hardware)
- The hardware streams back PID component values (`Pr`, `It`, `Dr`, `Ot`) each cycle, which are overlaid on the secondary chart

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| Target setpoint | Desired process value |
| Proportional gain (P) | Scales the current error |
| Integral gain (I) | Accumulates past error (eliminates steady-state offset) |
| Derivative gain (D) | Predicts future error (reduces overshoot) |
| Control type | Full `PID` controller |
| PID frequency | Hardware update rate |
| Fan/secondary | Independent secondary output |

**Product PID presets:**

| Product | P | I | D | Frequency |
|---------|---:|---:|---:|----------:|
| Pressure | 5 | 0.5 | 0 | 5 Hz |
| Servo Speed | 1.5 | 250 | 0.02 | 250 Hz |
| Servo Angle | 0.7 | 2 | 0.09 | 250 Hz |

The selected product's preset is loaded when its page opens and all four values are sent automatically when PID mode is entered. Later edits are remembered separately for each product. `Reset` restores that product's preset and sends the restored P/I/D/frequency values immediately.

**PID term chart datasets:**

| Controller | Active terms | Secondary canvas datasets |
|------------|-------------|--------------------------|
| PID | Proportional + Integral + Derivative | Output, P term, I term, D term |

**Hardware data cycle (two messages per cycle):**
1. Main data: `{T: <pv>, P: <output>, F: <fan>}`
2. PID data: `{Pr: <proportional>, It: <integral>, Dr: <derivative>, Ot: <output>}` — PID mode only

The renderer stores the PID message in `lastPidValues` and merges it with the next main data message when plotting.

**Chart:**
| Canvas | Dataset |
|--------|---------|
| Primary | Process variable, target line |
| Secondary | PID output + active PID term traces (1–4 datasets depending on sub-type) |

**Hardware commands:**
```json
{ "C": 3 }                   // switch to PID mode
{ "PID_P": 3.162 }           // set proportional gain
{ "PID_I": 0.01  }           // set integral gain
{ "PID_D": 150   }           // set derivative gain
{ "T": 45        }           // set target setpoint
{ "F": 50        }           // set fan speed
```

**Default gains:** `P = 3.162`, `I = 0.01`, `D = 150` (factory defaults; user-saved values persist in `localStorage`)

**Typical use:** precise setpoint tracking, laboratory experiments, closed-loop characterization

---

## Shared Hardware Page Safety

`pressure.html`, `level.html`, `flow.html`, `servo-speed.html`, and `servo-angle.html` use `renderer-hardware.js`. On first connection and every control-mode switch, the shared renderer resets the page to a safe idle state before sending the mode command. Brief USB reconnects preserve the current control mode instead of forcing Manual, so a heartbeat hiccup cannot silently switch the operator out of PID. When entering PID, the app sends `W:2` to clear the firmware integral accumulator once and sends the selected product's stored PID preset. The PID `Reset` button restores that preset and sends it immediately. For `P`, `F`, and `T`, the renderer sends a brief nonzero force-update command before the final safe value so firmware cached-value checks cannot leave a physical output running.

| Page | UI reset | Commands sent before mode command |
|------|----------|-----------------------------------|
| Pressure | Pump `0`, target `0 PSI`, relief valve `0`, valve button closed | `{H:0}`, `{F:1}`, `{F:0}`, `{P:1}`, `{P:0}`, `{T:1}`, `{T:0}` |
| Level | Pump `0`, target `0 mm`, valve `0` | `{F:1}`, `{F:0}`, `{P:1}`, `{P:0}`, `{T:1}`, `{T:0}` |
| Flow | Pump `0`, target `0 L/hr`, valve `0` | `{F:1}`, `{F:0}`, `{P:1}`, `{P:0}`, `{T:1}`, `{T:0}` |
| Servo Speed | Drive `0`, target `0 RPM` | `{P:1}`, `{P:0}`, `{T:1}`, `{T:0}` |
| Servo Angle | Drive `0`, target `0°` | `{P:1}`, `{P:0}`, `{T:1}`, `{T:0}` |

For pressure, `H` is a binary relief-valve alias handled by firmware: `0 = closed/off`, `1 = open/full`. Flow and Level use the analog `F` valve output instead.

---

## Servo Pages

The servo pages share the same three control modes as every other sensor page, but the sensor axis and output range reflect servo-specific values.

### Servo Speed (`servo-speed.html`)

Controls and monitors the rotational speed of a servo motor.

| Property | Value |
|----------|-------|
| Sensor label | Speed |
| Unit | RPM |
| Sensor range | 0–60 RPM |
| Primary output key | `P` (Drive) |
| Output range | −50 to +50 |
| Secondary output | None |

**Manual mode** — set the drive value directly (−50 to +50) to command a fixed motor speed.  
**On/Off mode** — the hardware switches the drive on or off to maintain a target speed within a hysteresis band.  
**PID mode** — the hardware computes a continuous drive signal to hold the speed at the setpoint; P, PI, PD, and full PID sub-types are available.

### Servo Angle (`servo-angle.html`)

Controls and monitors the angular position of a servo.

| Property | Value |
|----------|-------|
| Sensor label | Angle |
| Unit | ° (degrees) |
| Sensor range | −180° to +180° |
| Primary output key | `P` (Drive) |
| Output range | −50 to +50 |
| Secondary output | None |

**Manual mode** — set the drive value directly to command a fixed actuator drive.  
**On/Off mode** — the hardware switches the drive on or off to keep the angle within a hysteresis band around the setpoint.  
**PID mode** — the hardware drives the actuator continuously to track a target angle; all four PID sub-types (P / PI / PD / PID) are available.

Both servo pages use `renderer-hardware.js` configured via `window.HARDWARE_CONFIG` and implement the same PID two-message protocol, 40 ms command throttle, CSV export, and safety sequences as all other sensor pages.

---

## Real-Time Charts

Built with [Chart.js](https://www.chartjs.org/) — dual canvas layout on every sensor page:

| Mode | Primary Canvas | Secondary Canvas |
|------|---------------|-----------------|
| Manual | Process variable | Output % |
| On/Off | PV, target, upper/lower hysteresis bands | Output % |
| PID | PV, target | Output + active PID term traces |

- Auto-pauses chart plotting after **20 minutes** of no user interaction (sensor readings and CSV logging continue uninterrupted)
- Resumes automatically on the next control change
- Print graph support

---

## Hardware Communication

### Serial (COM Port)
- Auto port detection and manual selection
- Baud rates: `9600` to `115200`
- Connection status display and reconnect handling

### USB HID
- `node-hid` native bindings
- VID/PID based device identification (`VID=0x12BF, PID=0x0113`)
- Bootloader communication support

### Web Serial API (browser fallback)
- When neither Electron IPC nor the Express server is available, `renderer.js` can connect directly to hardware via the browser's Web Serial API
- Bootloader USB filtering uses `VID=0x12BF, PID=0x010C` (differs from main app `PID=0x0113`)

### Hardware JSON Protocol

Commands sent to hardware:

| Key | Value | Meaning |
|-----|-------|---------|
| `C` | `1 / 2 / 3` | Control mode: Manual / On/Off / PID |
| `P` | `0–100` (or device range) | Primary output (heater power %, drive, etc.) |
| `F` | `0–100` | Fan / secondary output % |
| `T` | setpoint value | Target setpoint |
| `Y` | `1–10` | Hysteresis (On/Off mode, device units) |
| `PID_P / PID_I / PID_D` | numeric | PID gains |
| `H` | `0 / 1` | Binary valve/heater-style off/on command; currently used by Pressure as relief valve closed/open |
| `A` | hardware ID | Hardware type identifier (sent by device on connect) |

Incoming data arrives as **two separate JSON messages per cycle**:

1. **Main data:** `{"T": 25.5, "P": 45.2, "F": 50}` — process variable, output, secondary output
2. **PID data:** `{"Pr": 5.67, "It": 2.89, "Dr": 1.23, "Ot": 12.34}` — PID component values (PID mode only)

Hardware also sends intermediate `{T}`-only packets between full cycles; these are buffered in `pendingIntermediateTPackets` and flushed equally distributed when the next full `{T, P, F}` message arrives.

Command writes are **throttled to a 40 ms minimum interval** to avoid serial flooding.

---

## Sidebar Apps (inside `index.html`)

`index.html` is a single-page shell with a left sidebar that switches between three apps. `admin.html` and `splash.html` were removed in v0.1.9 — the admin panel is now an inline sidebar page rather than a separate window, and `landing.html` replaced the splash screen.

| App | Default page | Contents |
|-----|---------------|----------|
| Main | Temperature dashboard | Charts and control modes (see above) |
| Admin | Dashboard tab | Tabs: Dashboard, PID Controls, Bootloader, Updates, Settings |
| Curriculum | Worksheet 1 | Worksheets `ws-1` … `ws-10` — PID / process-control teaching material with Prev/Next navigation |

The other sensor pages (`pressure.html`, `flow.html`, `level.html`, `servo-speed.html`, `servo-angle.html`) link back into `index.html` for the Admin Panel and Curriculum, and "back" returns to the correct sensor page rather than always landing on Temperature.

### Admin Panel

| Section | Features |
|---------|---------|
| Dashboard | Live system logs, raw HEX/ASCII data stream, runtime stats (uptime, packet rate), export |
| PID Controls | Direct PID value input and hardware send |
| Bootloader | Load HEX file, erase, program, verify, run full sequence, progress display |
| Updates | GitHub release check, current version display, download/install via `electron-updater` |

---

## Safety & Reliability

- **On connect:** hardware initialization sequence sent automatically
- **On close:** safe shutdown sequence — sets `C=1`, `F=0`, `P=0`, `H=0`, PID gains = `0`; setpoint is `T=20` on Temperature and `T=0` on non-temperature pages
- **On mode switch:** Temperature sends its safe reset sequence; shared hardware pages reset visible controls and send page-specific minimum/off commands before the new mode
- **On reconnect:** first connection safe-initializes to Manual; later brief reconnects preserve the active control mode and skip one chart point to avoid a visual jump
- **40 ms minimum command write interval** to avoid serial flooding
- **Keepalive heartbeat** every 100 ms detects disconnects; consecutive failures trigger automatic reconnect

---

## Data Export

- CSV export per sensor page (mode-specific column headers, started/stopped from UI)
- System log export
- Raw stream export

---

## Tablet & Browser Access

This is a **desktop application** — it is not a hosted web app. Browser/tablet access works in two ways:

### Option A — Tablet mirror via the desktop app (most common)

When the Electron desktop app is running, an embedded Express server starts automatically on a free LAN port. The desktop UI shows the server URL and a **QR code** — scan it from any phone or tablet to open the full control interface in a browser on the same network. The desktop app must be running; tablets do not install anything.

### Option B — Headless server mode (`npm run web`)

For environments where a GUI-less host is preferred (dedicated lab PC, Raspberry Pi), `server.js` can be run without launching an Electron window. The hardware must still be physically connected to the machine running the server. Any browser on the same network can then connect.

```bash
npm run web   # starts Express server, no Electron window
```

Both options:
- Are PWA-ready (`manifest.json`) — add to tablet home screen for an app-like experience
- Use a responsive layout for touch devices
- Fall back gracefully via `webCmd()` (thin fetch wrapper) and SSE via `setupServerBridge()` when Electron IPC is unavailable

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/events` | GET (SSE) | Live hardware data stream (`json-data`, `connection-status`) |
| `/api/command` | POST | Send control commands to hardware |
| `/api/ports` | GET | List available serial ports |
| `/api/connect` | POST | Connect to a serial port |
| `/api/disconnect` | POST | Disconnect from hardware |
| `/api/state` | GET | Current shared state + connection info |
| `/api/server-info` | GET | Network IPs, URL, QR code |

---

## Architecture

```
main.js  (Electron main process)
  ├── SerialPort / node-hid    →  hardware communication
  ├── Embedded Express server  →  phone/tablet mirroring via SSE + REST
  ├── ~30 IPC handlers         →  UI commands → hardware writes
  ├── electron-updater          →  GitHub release auto-updates
  └── preload.js                →  secure IPC bridge (context isolation)

server.js  (headless server — npm run web, hardware must be connected to this machine)
  ├── Real SerialPort           →  direct hardware bridge (no Electron window)
  ├── SSE /api/events           →  pushes json-data & connection-status to browsers
  └── REST /api/*               →  ports, connect, disconnect, command, server-info

renderer.js  (temperature sensor page — Electron renderer / browser, ~6100 lines)
  ├── Chart.js (dual canvas)   →  primary (PV) + secondary (output/PID)
  ├── setupServerBridge()      →  replaces IPC stubs with fetch/SSE in browser mode
  ├── UI state machine         →  control modes, form values, chart datasets
  └── inactivity logic         →  pauses chart after 20 min idle

renderer-hardware.js  (all other sensor pages — self-contained IIFE)
  ├── Same control-mode state machine as renderer.js
  ├── Same dual-canvas Chart.js setup and PID two-message protocol
  ├── Driven by window.HARDWARE_CONFIG per page
  └── Isolated state — does not share variables with renderer.js
```

Context isolation is enabled. `preload.js` exposes only a narrow `window.electronAPI` surface — `nodeIntegration` is disabled in the renderer.

---

## Key Files

| File | Purpose |
|------|---------|
| [main.js](main.js) | Hardware I/O, IPC handlers, safety sequences, bootloader |
| [preload.js](preload.js) | IPC bridge (context isolation) |
| [renderer.js](renderer.js) | Temperature sensor page UI logic (~6100 lines): control modes, charting, CSV export |
| [renderer-hardware.js](renderer-hardware.js) | Shared renderer for Pressure, Flow, Level, Servo Speed, and Servo Angle pages; driven by `window.HARDWARE_CONFIG` |
| [layout.js](layout.js) | Clock, mode toggle, live reading display sync |
| [server.js](server.js) | Standalone Express server for web/tablet deployment |
| [landing.html](landing.html) | Startup landing page — hardware status banner + auto-routing on `{A: X}` |
| [index.html](index.html) | Temperature sensor page; also hosts the Admin Panel and Curriculum worksheets as sidebar-switched sub-pages |
| [pressure.html](pressure.html) | Pressure sensor page |
| [flow.html](flow.html) | Flow sensor page |
| [level.html](level.html) | Level sensor page |
| [servo-speed.html](servo-speed.html) | Servo speed sensor page (0–60 RPM) |
| [servo-angle.html](servo-angle.html) | Servo angle sensor page (−180°–180°) |
| [assets/css/matrix-ui.css](assets/css/matrix-ui.css) | DaisyUI + Tailwind UI styles |
| [CLAUDE.md](CLAUDE.md) | Developer guidance for Claude Code |
| [AGENTS.md](AGENTS.md) | Developer guidance for Codex |

---

## Tech Stack

| Package | Version |
|---------|---------|
| `electron` | `^43.1.0` |
| `electron-builder` | `^26.15.3` |
| `electron-updater` | `^6.6.2` |
| `chart.js` | `^4.4.4` |
| `express` | `^4.21.2` |
| `serialport` | `^12.0.0` |
| `node-hid` | `^3.1.1` |
| `qrcode` | latest |

---

## System Requirements

- **OS:** Windows 10 / 11 recommended (cross-platform build support exists)
- **Node.js:** 16+
- **Hardware:** Compatible process control unit (Serial or USB HID)

For native module builds on Windows you may also need:
- Python
- Visual Studio Build Tools

---

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **If `node-hid` has build errors on Windows, rebuild it:**
   ```bash
   npm run rebuild-hid
   ```

3. **Run in web mode (recommended for development):**
   ```bash
   npm run web
   ```
   Open `http://localhost:3000` in a browser.

4. **Run as Electron desktop app:**
   ```bash
   npm start
   ```

---

## Usage

1. Connect hardware via Serial COM port or USB HID
2. The app auto-navigates to the matching sensor page based on the `{A: X}` hardware ID
3. Select a control mode: **Manual**, **On/Off**, or **PID**
4. Set values (output, setpoint, hysteresis, or PID gains as appropriate)
5. Monitor live chart data on both canvases
6. Open the Admin Panel for logs, firmware updates, and bootloader tools
7. Export data to CSV when needed

---

## Change History

For full technical detail, see [CHANGELOG.md](CHANGELOG.md).

### v0.1.9 (current)
- **Landing page** — app now opens `landing.html` on startup; displays hardware status banner and product cards for all six sensor types
- **Hardware auto-routing** — when the device sends `{A: X}` on connect, the app reads the hardware ID (201–206) and auto-navigates to the matching sensor page after a 1.2 s delay
- **`open-external-url` IPC** — landing page product links open in the system browser via `shell.openExternal` (gated to `http/https` URLs only)
- **`hardware-id-received` event** — `preload.js` exposes `onHardwareIdReceived` callback so the landing page can react to `{A: X}` without polling
- **Electron upgraded** — `^38.2.2` → `^43.1.0`; `electron-builder` `^24.13.3` → `^26.15.3`
- **Sensor product images** — added `.webp` assets for all six sensor types
- **Reconnect mode restore** — after reconnect, renderer restores the control mode active before disconnect (rather than always resetting to Manual)
- **`splash.html` removed** — superseded by `landing.html`

### v0.1.8
- **Multi-sensor suite** — added Pressure, Flow, Level, Servo Speed, and Servo Angle pages; all share `renderer-hardware.js` configured via `window.HARDWARE_CONFIG`
- **Intermediate T-only packet buffering** — `renderer.js` buffers `{T}` packets and flushes them equally distributed between main data packets
- **Auto-reconnect UX** — charts cleared and UI resets to Manual mode on reconnect; debounced 1 s delay before sending `C:1`
- **Slider drag fix** — sliders send the hardware command on `change` (release) only, not on every `input` event
- **PID input visibility** — I and D containers shown/hidden automatically based on active PID sub-type
- **Per-field PID send** — P, I, D gain inputs each send to hardware individually on `change`
- **Hysteresis floor fix** — On/Off lower band clamps to `CFG.sensor.min` instead of hardcoded `0`

### v0.1.6
- **Embedded web server** — Electron desktop app starts an Express server on a free LAN port; shows URL and QR code for phone/tablet access
- **SSE data stream** — hardware data pushed to all connected browsers via `GET /api/events`
- **`server.js` fully rewritten** — replaced all mock endpoints with real `serialport` integration
- **`setupServerBridge()`** in renderer — browser clients swap Electron IPC stubs for fetch/SSE transparently
- **Shared control state** (`sharedState`) in `main.js` — single source of truth across desktop + web clients

### v0.1.5
- Admin panel moved inline into main window
- PID default gains fall back to `localStorage` values; inputs pre-populated from saved defaults on startup
- PID gains in admin panel sync live with main app PID input fields
- Admin log system refactored: persistent session history in `localStorage`
- Session tracking added: sessions logged with port label on connect/disconnect

### v0.1.4
- Admin panel moved inline into main window — no longer a separate Electron window
- Added Integral Windup toggle in PID mode (PI sub-type only)
- PID default gains persist in `localStorage`; Restore to Default button added (`P=3.162, I=0.01, D=150`)
- Bootloader Connect auto-enables and auto-connects USB HID after Trigger Bootloader succeeds
- Erase-Program-Verify shows live progress at each step

### v0.1.3
- Project cleanup: removed orphaned files and unused vendored 3D libs (~7.5 MB)
- Removed unused npm packages — 70 packages pruned

### v0.1.2
- UI migrated to DaisyUI + Tailwind CSS design system
- Improved layout for desktop and tablet

### v0.0.3 (February 4, 2026)
- Fixed chart shadow/fill rendering artifacts
- Improved chart cleanup and re-initialization on mode switch
- Added stale-data skip after mode change
- Fixed target temperature input — updates on Enter/blur, not while typing

### Unreleased (December 2024 – February 2026)
- Two-message PID data reception (`Pr`, `It`, `Dr`, `Ot` as separate JSON)
- Automatic safe init sequence on hardware connect
- Automatic safe shutdown sequence on app close
- Safe mode-switch sequence (fan off, heater off, safe target, power 0)
- 20-minute inactivity chart pause (sensor data and CSV logging unaffected)

---

## License

MIT — © Matrix TSL
