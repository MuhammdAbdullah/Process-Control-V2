// Web server for Heat Transfer App — serves UI and bridges serial hardware to browsers via SSE + REST
const express = require('express');
const path = require('path');
const os = require('os');
const { SerialPort } = require('serialport');
const QRCode = require('qrcode');

const app = express();

// Hardware target identifiers (same as main.js)
const TARGET_VENDOR_ID = '12BF';
const TARGET_PRODUCT_ID = '0113';
const SERIAL_MIN_COMMAND_INTERVAL_MS = 40;
const QL_HEARTBEAT_INTERVAL_MS = 100; // 10 Hz telemetry requests for fast Level response logging.

// Serial state
let serialPort = null;
let isConnected = false;
let serverPort = null;
let activeSerialPath = null;
let jsonRxBuffer = '';
let serialWriteQueue = Promise.resolve();
let lastSerialWriteTime = 0;
let autoConnectRetryTimer = null;
let qlHeartbeatTimer = null;
let qlHeartbeatInFlight = false;

// SSE clients — each entry is an Express response object with SSE headers set
let sseClients = [];

// Keep-alive ping every 20s so mobile browsers don't drop the SSE connection
setInterval(() => {
    sseClients = sseClients.filter(client => {
        try { client.write(': keepalive\n\n'); return true; } catch { return false; }
    });
}, 20000);

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());

const CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:;";

app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', CSP);
    }
    next();
});

// ── Server info (must be before static middleware) ────────────────────────────
app.get('/api/server-info', async (req, res) => {
    try {
        const ips = getNetworkIPs();
        const port = serverPort || (serverInstance ? serverInstance.address().port : req.socket.localPort);
        const urls = ips.map(ip => `http://${ip}:${port}`);
        const primaryUrl = urls[0] || `http://localhost:${port}`;
        const qrCode = await QRCode.toDataURL(primaryUrl, { width: 200 });
        res.json({ port, ips, urls, primaryUrl, qrCode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use(express.static('.'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── SSE broadcast ─────────────────────────────────────────────────────────────

function broadcast(eventName, data) {
    const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients = sseClients.filter(client => {
        try { client.write(msg); return true; } catch { return false; }
    });
}

// ── REST API ──────────────────────────────────────────────────────────────────

// Stream hardware events to browser (json-data, connection-status)
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    // Immediately send current connection state to new subscriber
    res.write(`event: connection-status\ndata: ${JSON.stringify({ connected: isConnected, port: activeSerialPath })}\n\n`);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

// List real serial ports
app.get('/api/ports', async (req, res) => {
    try {
        const ports = await SerialPort.list();
        res.json(ports);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Connection status
app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected, port: activeSerialPath });
});

// Connect to a serial port
app.post('/api/connect', async (req, res) => {
    const { port: portPath, baudRate = 115200 } = req.body || {};
    if (!portPath) return res.status(400).json({ success: false, error: 'port is required' });
    const result = await connectSerial(portPath, parseInt(baudRate));
    res.json(result);
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
    try {
        stopQlHeartbeat();
        if (serialPort && serialPort.isOpen) {
            await new Promise(resolve => serialPort.close(() => resolve()));
        }
        isConnected = false;
        activeSerialPath = null;
        broadcast('connection-status', { connected: false });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Send a JSON command to hardware
app.post('/api/command', async (req, res) => {
    const command = req.body;
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
        return res.status(400).json({ success: false, error: 'body must be a JSON object' });
    }
    if (!isConnected) {
        return res.status(503).json({ success: false, error: 'Hardware not connected' });
    }
    try {
        await sendJsonCommand(command, 'web-command');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Serial communication ──────────────────────────────────────────────────────

function queueSerialWrite(task) {
    const next = serialWriteQueue.catch(() => {}).then(() => task());
    serialWriteQueue = next;
    return next;
}

async function sendJsonCommand(commandObj, description) {
    const jsonStr = JSON.stringify(commandObj);
    const payload = Buffer.from(jsonStr + '\n', 'utf8');
    await queueSerialWrite(async () => {
        if (!serialPort || !serialPort.isOpen) throw new Error('Not connected');

        const elapsed = Date.now() - lastSerialWriteTime;
        if (elapsed < SERIAL_MIN_COMMAND_INTERVAL_MS) {
            await new Promise(r => setTimeout(r, SERIAL_MIN_COMMAND_INTERVAL_MS - elapsed));
        }
        await new Promise((resolve, reject) => {
            serialPort.write(payload, (writeErr) => {
                if (writeErr) return reject(writeErr);
                serialPort.drain((drainErr) => {
                    if (drainErr) return reject(drainErr);
                    lastSerialWriteTime = Date.now();
                    resolve();
                });
            });
        });
        console.log(`[TX] ${description}: ${jsonStr}`);
    });
}

function handleSerialData(data) {
    try {
        jsonRxBuffer += data.toString('utf8');

        let jsonStart = jsonRxBuffer.indexOf('{');
        while (jsonStart !== -1) {
            let braceCount = 0;
            let jsonEnd = -1;
            for (let i = jsonStart; i < jsonRxBuffer.length; i++) {
                if (jsonRxBuffer[i] === '{') braceCount++;
                else if (jsonRxBuffer[i] === '}') {
                    if (--braceCount === 0) { jsonEnd = i; break; }
                }
            }
            if (jsonEnd === -1) break;

            const jsonStr = jsonRxBuffer.substring(jsonStart, jsonEnd + 1);
            try {
                const parsed = JSON.parse(jsonStr);
                const isMain = 'T' in parsed && 'P' in parsed && 'F' in parsed;
                const isPid  = 'Pr' in parsed || 'It' in parsed || 'Dr' in parsed || 'Ot' in parsed;
                if (isMain || isPid) {
                    broadcast('json-data', parsed);
                    console.log('📥 JSON →', jsonStr);
                }
            } catch { /* malformed JSON, skip */ }

            jsonRxBuffer = jsonRxBuffer.substring(jsonEnd + 1);
            jsonStart = jsonRxBuffer.indexOf('{');
        }

        if (jsonRxBuffer.length > 1000) jsonRxBuffer = '';
    } catch { /* binary data, ignore */ }
}

function startQlHeartbeat() {
    stopQlHeartbeat();
    qlHeartbeatTimer = setInterval(async () => {
        if (qlHeartbeatInFlight) return;
        if (!isConnected || !serialPort || !serialPort.isOpen) return;
        qlHeartbeatInFlight = true;
        try { await sendJsonCommand({ QL: 1 }, 'heartbeat'); } catch { /* ignore */ }
        finally { qlHeartbeatInFlight = false; }
    }, QL_HEARTBEAT_INTERVAL_MS);
    console.log(`[HEARTBEAT] QL heartbeat started (${QL_HEARTBEAT_INTERVAL_MS}ms)`);
}

function stopQlHeartbeat() {
    if (qlHeartbeatTimer) {
        clearInterval(qlHeartbeatTimer);
        qlHeartbeatTimer = null;
    }
    qlHeartbeatInFlight = false;
}

async function connectSerial(portPath, baudRate) {
    try {
        if (serialPort && serialPort.isOpen) {
            await new Promise(resolve => serialPort.close(() => resolve()));
        }

        serialPort = new SerialPort({
            path: portPath,
            baudRate: baudRate || 115200,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            autoOpen: false
        });

        serialPort.on('data', handleSerialData);

        serialPort.on('error', (err) => {
            console.error('[SERIAL] Error:', err.message);
            isConnected = false;
            broadcast('connection-status', { connected: false, error: err.message });
        });

        serialPort.on('close', () => {
            console.log('[SERIAL] Port closed');
            isConnected = false;
            stopQlHeartbeat();
            broadcast('connection-status', { connected: false });
            scheduleAutoConnect(10000);
        });

        await new Promise((resolve, reject) => {
            serialPort.open(err => err ? reject(err) : resolve());
        });

        isConnected = true;
        activeSerialPath = portPath;
        serialWriteQueue = Promise.resolve();
        lastSerialWriteTime = 0;
        jsonRxBuffer = '';

        broadcast('connection-status', { connected: true, port: portPath });
        console.log(`[SERIAL] Connected to ${portPath} at ${baudRate} baud`);

        // Start QL heartbeat — hardware only streams data when polled with {QL:1}
        startQlHeartbeat();

        return { success: true, port: portPath };
    } catch (err) {
        console.error('[SERIAL] Connect error:', err.message);
        return { success: false, error: err.message };
    }
}

// ── Auto-connect on startup ───────────────────────────────────────────────────

function scheduleAutoConnect(delayMs) {
    if (autoConnectRetryTimer) clearTimeout(autoConnectRetryTimer);
    autoConnectRetryTimer = setTimeout(autoConnect, delayMs);
}

async function autoConnect() {
    if (isConnected) return;
    try {
        const ports = await SerialPort.list();
        const target = ports.find(p =>
            p.vendorId && p.productId &&
            p.vendorId.toUpperCase() === TARGET_VENDOR_ID &&
            p.productId.toUpperCase() === TARGET_PRODUCT_ID
        );

        if (target) {
            console.log(`[AUTO] Device found on ${target.path}, connecting...`);
            const result = await connectSerial(target.path, 115200);
            if (!result.success) scheduleAutoConnect(5000);
        } else {
            console.log('[AUTO] Device not found, retrying in 10s...');
            scheduleAutoConnect(10000);
        }
    } catch (err) {
        console.error('[AUTO] Error:', err.message);
        scheduleAutoConnect(10000);
    }
}

// ── Startup ───────────────────────────────────────────────────────────────────

function getNetworkIPs() {
    const VIRTUAL = [/virtualbox/i, /vmware/i, /vmnet/i, /vethernet/i, /hyper-v/i, /loopback/i, /bluetooth/i, /tunnel/i, /teredo/i, /isatap/i];
    const VIRTUAL_RANGES = ['192.168.56.', '192.168.137.'];
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
        if (VIRTUAL.some(p => p.test(name))) continue;
        for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal && !VIRTUAL_RANGES.some(r => addr.address.startsWith(r))) {
                ips.push(addr.address);
            }
        }
    }
    if (ips.length) return ips;
    return Object.values(ifaces).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
}

const serverInstance = app.listen(0, () => {
    serverPort = serverInstance.address().port;
    const PORT = serverPort;
    console.log('\nHeat Transfer Web App running!\n');
    console.log(`  Local:   http://localhost:${PORT}`);
    getNetworkIPs().forEach(ip => {
        console.log(`  Network: http://${ip}:${PORT}  ← open this on your phone`);
    });
    console.log('');
    autoConnect();
});
