require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const Orchestrator = require('./orchestrator');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- CORS ---
// CORS_ORIGIN: comma-separated allowlist. "*" = allow all (dev only). Empty = same-origin only.
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const corsAllowlist = CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
const CORS_ALLOWED_HEADERS = ['Content-Type', 'X-Anthropic-Key', 'X-Gemini-Key', 'X-Kimi-Key', 'X-Kimi-Url', 'X-Ollama-Url', 'X-Ollama-Model'];

// The dashboard is served by THIS server, but its API calls carry custom headers
// (X-*-Key), so the browser tags them as CORS requests and sends an Origin header
// even same-origin. Always allow an Origin whose host matches our own Host — that's
// the dashboard talking to itself — regardless of port or allowlist.
function isAllowedOrigin(origin, req) {
    if (!origin) return true;                  // non-CORS (curl, same-origin simple GET)
    if (corsAllowlist === '*') return true;
    try {
        if (req.headers.host && new URL(origin).host === req.headers.host) return true;
    } catch { /* malformed Origin → fall through to allowlist */ }
    return corsAllowlist.includes(origin);
}

// Delegate form gives us access to `req` (needed for the same-origin host check).
// On a disallowed origin we simply omit CORS headers (browser blocks it) instead of
// throwing — a rejected cross-origin call must never surface as a 500.
app.use(cors((req, cb) => {
    cb(null, {
        origin: isAllowedOrigin(req.headers.origin, req),
        allowedHeaders: CORS_ALLOWED_HEADERS
    });
}));

// --- Security headers ---
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
            "font-src https://fonts.gstatic.com",
            "img-src 'self' data:",
            "connect-src 'self' ws: wss:",
            "frame-ancestors 'none'"
        ].join('; ')
    );
    next();
});

app.use(express.json({ limit: '1mb' }));

// Serve frontend from parent directory
app.use(express.static(path.join(__dirname, '..')));

// --- WebSocket connections ---
const clients = new Set();
wss.on('connection', ws => {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    try { ws.send(JSON.stringify({ type: 'connected', msg: 'Connected to Nebulux server' })); } catch { /* socket already dead */ }
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
});

// Heartbeat: drop dead sockets every 30s
const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) { clients.delete(ws); return ws.terminate(); }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
    });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

function broadcast(data) {
    let msg;
    try { msg = JSON.stringify(data); } catch { return; }
    clients.forEach(ws => {
        if (ws.readyState === 1) {
            try { ws.send(msg); } catch { /* drop next tick */ }
        }
    });
}

// Create orchestrator
const KIMI_URL = process.env.KIMI_URL || 'http://localhost:8000';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:latest';
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const orchestrator = new Orchestrator({
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    kimiKey: process.env.KIMI_API_KEY,
    kimiUrl: KIMI_URL,
    ollamaUrl: OLLAMA_URL,
    ollamaModel: OLLAMA_MODEL,
    outputDir: OUTPUT_DIR,
    broadcast
});

let currentRun = null;

// Extract user-provided keys from headers (BYOK). Empty values are ignored
// so the orchestrator falls back to .env defaults for local-dev convenience.
function extractClientKeys(req) {
    const pick = (h) => {
        const v = req.get(h);
        return (typeof v === 'string' && v.trim()) ? v.trim() : undefined;
    };
    return {
        anthropicKey: pick('X-Anthropic-Key'),
        geminiKey: pick('X-Gemini-Key'),
        kimiKey: pick('X-Kimi-Key'),
        kimiUrl: pick('X-Kimi-Url'),
        ollamaUrl: pick('X-Ollama-Url'),
        ollamaModel: pick('X-Ollama-Model')
    };
}

// Sanitize/validate custom-model definitions from the client.
// SECURITY: custom models let a caller make THIS server issue HTTP requests to an
// arbitrary baseUrl. That is intentional (local BYOK endpoints such as Ollama/NIM
// live on localhost/private IPs), but it is an SSRF surface. Do NOT expose this
// server to untrusted networks — keep it bound to localhost or behind auth.
function sanitizeCustomModels(input) {
    if (!Array.isArray(input)) return [];
    return input
        .filter(m => m && typeof m === 'object')
        .map(m => ({
            id: typeof m.id === 'string' ? m.id.slice(0, 64) : '',
            name: typeof m.name === 'string' ? m.name.slice(0, 80) : '',
            baseUrl: typeof m.baseUrl === 'string' ? m.baseUrl.slice(0, 500) : '',
            model: typeof m.model === 'string' ? m.model.slice(0, 200) : '',
            apiKey: typeof m.apiKey === 'string' ? m.apiKey.slice(0, 500) : ''
        }))
        .filter(m => m.id && m.baseUrl && m.model && /^https?:\/\//i.test(m.baseUrl))
        .slice(0, 20); // hard cap
}

// API Routes
const MAX_DESC_LEN = 8000;
app.post('/api/run', async (req, res) => {
    if (currentRun) return res.status(409).json({ error: 'Pipeline already running' });

    const { projectDescription, models, customModels } = req.body || {};
    if (typeof projectDescription !== 'string' || !projectDescription.trim()) {
        return res.status(400).json({ error: 'projectDescription is required and must be a non-empty string' });
    }
    if (projectDescription.length > MAX_DESC_LEN) {
        return res.status(413).json({ error: `projectDescription exceeds ${MAX_DESC_LEN} characters` });
    }
    if (models !== undefined && (typeof models !== 'object' || Array.isArray(models))) {
        return res.status(400).json({ error: 'models must be an object' });
    }

    const clientKeys = extractClientKeys(req);
    const cleanCustom = sanitizeCustomModels(customModels);

    res.json({ status: 'started', message: 'Pipeline started' });

    currentRun = orchestrator.run(projectDescription.trim(), models, clientKeys, cleanCustom)
        .then(result => { currentRun = null; return result; })
        .catch(err => { currentRun = null; console.error('Pipeline error:', err); });
});

app.get('/api/status', (req, res) => {
    res.json({ running: !!currentRun });
});

// Stop the in-progress pipeline (Stop button). Aborts in-flight provider calls
// and halts the run at the next checkpoint.
app.post('/api/stop', (req, res) => {
    if (!currentRun) return res.status(409).json({ error: 'No pipeline is running' });
    orchestrator.cancel();
    res.json({ status: 'stopping' });
});

// Download a generated project folder as a .zip. The :project param is sanitized
// the same way the orchestrator names folders, then resolved strictly inside
// OUTPUT_DIR to prevent path traversal.
app.get('/api/download/:project', (req, res) => {
    const safe = String(req.params.project || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    if (!safe || /^[._-]+$/.test(safe)) return res.status(400).json({ error: 'Invalid project name' });

    const base = path.resolve(OUTPUT_DIR);
    const dir = path.resolve(base, safe);
    if (dir !== base && !dir.startsWith(base + path.sep)) {
        return res.status(400).json({ error: 'Invalid project path' });
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return res.status(404).json({ error: 'Project not found. Build it first.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
        console.error('Archive error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to create archive' });
        else res.destroy(err);
    });
    archive.pipe(res);
    archive.directory(dir, safe); // nest everything under a top-level folder
    archive.finalize();
});

// Health check (key presence only)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        apis: {
            claude: !!process.env.ANTHROPIC_API_KEY,
            gemini: !!process.env.GEMINI_API_KEY,
            kimi: !!process.env.KIMI_API_KEY,
            ollama: process.env.OLLAMA_URL || 'http://localhost:11434'
        }
    });
});

// Live API connectivity check — actually pings each provider.
// Client keys (from headers) take precedence over env vars.
async function checkClaude(clientKey) {
    const key = clientKey || process.env.ANTHROPIC_API_KEY;
    if (!key) return { ok: false, status: 'missing_key', message: 'No Anthropic key provided. Add one in Settings.' };
    const t0 = Date.now();
    try {
        const client = new Anthropic({ apiKey: key });
        const r = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4,
            messages: [{ role: 'user', content: 'ping' }]
        });
        return { ok: true, status: 'connected', message: `Model: ${r.model}`, latency: Date.now() - t0 };
    } catch (e) {
        return { ok: false, status: 'error', message: e.message?.slice(0, 200) || 'Unknown error', latency: Date.now() - t0 };
    }
}

async function checkGemini(clientKey) {
    const key = clientKey || process.env.GEMINI_API_KEY;
    if (!key) return { ok: false, status: 'missing_key', message: 'No Gemini key provided. Add one in Settings.' };
    const t0 = Date.now();
    try {
        const genai = new GoogleGenAI({ apiKey: key });
        const r = await genai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'ping' });
        const text = (r.text || '').slice(0, 30);
        return { ok: true, status: 'connected', message: `Reply: "${text}"`, latency: Date.now() - t0 };
    } catch (e) {
        return { ok: false, status: 'error', message: e.message?.slice(0, 200) || 'Unknown error', latency: Date.now() - t0 };
    }
}

async function checkKimi(clientUrl, clientKey) {
    const url = (clientUrl || process.env.KIMI_URL || 'http://localhost:8000').replace(/\/+$/, '');
    const key = clientKey || process.env.KIMI_API_KEY;
    const t0 = Date.now();
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;
    try {
        const r = await axios.post(`${url}/v1/chat/completions`, {
            model: 'moonshotai/kimi-k2.6',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 4
        }, { headers, timeout: 15000 });
        return { ok: true, status: 'connected', message: `NIM @ ${url} • model: ${r.data?.model || 'kimi-k2.6'}`, latency: Date.now() - t0 };
    } catch (e) {
        const detail = e.response?.data?.error?.message || e.response?.data?.detail || e.code || e.message || 'Unknown error';
        const hint = (e.code === 'ECONNREFUSED') ? ` — is the NIM container running on ${url}?` : '';
        return { ok: false, status: 'error', message: `${detail}${hint}`.slice(0, 200), latency: Date.now() - t0 };
    }
}

async function checkOllama(clientUrl, clientModel) {
    const url = (clientUrl || OLLAMA_URL).replace(/\/+$/, '');
    const wanted = clientModel || OLLAMA_MODEL;
    const t0 = Date.now();
    try {
        const r = await axios.get(`${url}/api/tags`, { timeout: 5000 });
        const models = (r.data?.models || []).map(m => m.name);
        // Match exact name OR base name (e.g. "gemma3" matches "gemma3:latest")
        const hasExact = models.some(n => n === wanted || n.startsWith(`${wanted}:`));
        if (hasExact) {
            return {
                ok: true,
                status: 'connected',
                message: `${models.length} model(s) • ${wanted} ✓`,
                latency: Date.now() - t0
            };
        }
        const gemmaLike = models.filter(n => n.toLowerCase().includes('gemma'));
        const hint = gemmaLike.length
            ? ` Found similar: ${gemmaLike.join(', ')}. Set OLLAMA_MODEL or run: ollama pull ${wanted}`
            : ` Run: ollama pull ${wanted}`;
        return {
            ok: false,
            status: 'error',
            message: `Model '${wanted}' NOT installed.${hint}`.slice(0, 200),
            latency: Date.now() - t0
        };
    } catch (e) {
        return { ok: false, status: 'error', message: `Cannot reach ${url}: ${e.message}`.slice(0, 200), latency: Date.now() - t0 };
    }
}

async function checkCustomModel(cfg) {
    const t0 = Date.now();
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const url = /\/chat\/completions\/?$/.test(cfg.baseUrl) ? cfg.baseUrl : `${cfg.baseUrl}/chat/completions`;
    try {
        const r = await axios.post(url, {
            model: cfg.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 4
        }, { headers, timeout: 15000 });
        const replied = r.data?.choices?.[0]?.message?.content || '(empty)';
        return { ok: true, status: 'connected', message: `${cfg.name} • ${cfg.model} • ${String(replied).slice(0, 30)}`, latency: Date.now() - t0 };
    } catch (e) {
        const msg = e.response?.data?.error?.message || e.response?.data?.detail || e.code || e.message || 'Unknown error';
        const tail = e.response?.status ? ` (HTTP ${e.response.status})` : '';
        return { ok: false, status: 'error', message: `${msg}${tail}`.slice(0, 200), latency: Date.now() - t0 };
    }
}

// Accepts customModels in body. POST so a body is supported cleanly.
app.post('/api/health/check', async (req, res) => {
    const k = extractClientKeys(req);
    const customs = sanitizeCustomModels(req.body?.customModels);
    const [claude, gemini, kimi, ollama, ...customResults] = await Promise.all([
        checkClaude(k.anthropicKey),
        checkGemini(k.geminiKey),
        checkKimi(k.kimiUrl, k.kimiKey),
        checkOllama(k.ollamaUrl, k.ollamaModel),
        ...customs.map(c => checkCustomModel(c))
    ]);
    const providers = { claude, gemini, kimi, ollama };
    customs.forEach((c, i) => { providers[`custom:${c.id}`] = customResults[i]; });
    const allOk = Object.values(providers).every(p => p.ok);
    res.json({
        allOk,
        checkedAt: new Date().toISOString(),
        providers
    });
});

// Global error route — must come AFTER all routes
app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Unhandled promise rejections / uncaught exceptions — log, don't crash silently
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});

const PORT = Number(process.env.PORT) || 3000;

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} is already in use. Another instance running? Set PORT=<other> in .env.\n`);
    } else {
        console.error('\n❌ Server error:', err.message, '\n');
    }
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`\n✧ Nebulux Server running on http://localhost:${PORT}`);
    console.log(`  Dashboard: http://localhost:${PORT}`);
    console.log(`  Env:      ${process.env.NODE_ENV || 'development'}`);
    console.log(`  CORS:     ${CORS_ORIGIN || '(same-origin only)'}`);
    console.log(`  API Keys: Claude=${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'} Gemini=${process.env.GEMINI_API_KEY ? '✓' : '✗'} Kimi=${process.env.KIMI_API_KEY ? '✓' : '(no auth)'}`);
    console.log(`  Kimi NIM: ${KIMI_URL}`);
    console.log(`  Ollama:   ${OLLAMA_URL} (model: ${OLLAMA_MODEL})\n`);
});

// Graceful shutdown
function shutdown(signal) {
    console.log(`\n${signal} received — shutting down gracefully...`);
    clearInterval(heartbeat);
    wss.clients.forEach(ws => { try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ } });
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
    // Force-exit after 10s if connections refuse to close
    setTimeout(() => { console.warn('Forcing exit after timeout.'); process.exit(1); }, 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
