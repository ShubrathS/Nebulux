// ===== STARS =====
const sc=document.getElementById('starsCanvas'),cx=sc.getContext('2d');let stars=[];
function initStars(){sc.width=innerWidth;sc.height=innerHeight;stars=Array.from({length:180},()=>({x:Math.random()*sc.width,y:Math.random()*sc.height,r:Math.random()*1.4+0.3,a:Math.random(),s:Math.random()*0.004+0.001}))}
function drawStars(){cx.clearRect(0,0,sc.width,sc.height);stars.forEach(s=>{s.a+=s.s;cx.beginPath();cx.arc(s.x,s.y,s.r,0,Math.PI*2);cx.fillStyle=`rgba(170,190,255,${0.25+Math.sin(s.a)*0.35})`;cx.fill()});requestAnimationFrame(drawStars)}
initStars();drawStars();addEventListener('resize',initStars);

// ===== AGENT DATA =====
const AGENTS = {
    supervisor: { name: '🧠 Supervisor', desc: 'Orchestrates the pipeline, validates each agent\'s output, and coordinates handoffs between stages. Use the dropdown to pick the model that runs validation and final review.' },
    planner: { name: '📋 Planner', desc: 'Analyzes the project description and produces a structured implementation plan: tech stack, file structure, API endpoints, data models, and design requirements. Pick the model best at structured JSON reasoning.' },
    designer: { name: '🎨 UI/UX Designer', desc: 'Produces a design spec and then generates the frontend (HTML, CSS, JS) for each page in the plan. The same chosen model handles both stages.' },
    coder: { name: '⚙️ Backend Coder', desc: 'Generates the Node/Express backend (server entry, routes, data models) and then does a review/polish pass. Falls back to Claude only if the chosen model fails (this is logged).' },
    devops: { name: '🚀 DevOps / Tester', desc: 'Writes Jest tests, reviews all generated code for bugs, generates Docker deployment config, and writes the README.' }
};

const PIPELINE = ['planner','designer','coder','devops'];
const STAGES = ['supervisor', ...PIPELINE];
const MODEL_DEFAULTS = { planner:'claude', designer:'kimi', coder:'gemma', devops:'claude', supervisor:'claude' };
const MODEL_LABELS = { claude:'🧠 Claude', gemini:'💎 Gemini', kimi:'🌙 Kimi K2.6', gemma:'🔧 Gemma 3' };
let selectedAgent = 'supervisor';
let isRunning = false;
let ws = null;
// True when the server itself has provider keys configured (.env fallback), so the
// pipeline can run even if the browser has no BYOK keys saved. Populated on init.
let serverHasKeys = false;

// ===== DOM =====
const logBody = document.getElementById('log-body');
const detailTitle = document.getElementById('detail-title');
const detailDesc = document.getElementById('detail-desc');
const detailBadge = document.getElementById('detail-badge');
const connDot = document.getElementById('conn-dot');

// ===== WEBSOCKET =====
const API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : '';
const WS_BASE = location.protocol === 'file:' ? 'ws://localhost:3000' : (location.protocol === 'https:' ? 'wss://' + location.host : 'ws://' + location.host);

let wsReconnectAttempt = 0;
const WS_MAX_BACKOFF = 30000; // 30s cap
function setConnState(state) {
    const connText = document.getElementById('conn-text');
    if (state === 'connected') {
        connDot.style.color = '#10b981';
        connDot.title = 'Connected to server';
        if (connText) connText.textContent = 'Connected';
    } else {
        connDot.style.color = '#ef4444';
        connDot.title = 'Disconnected';
        if (connText) connText.textContent = state === 'connecting' ? 'Connecting…' : 'Disconnected';
    }
}

function connectWS() {
    setConnState('connecting');
    try {
        ws = new WebSocket(WS_BASE);
    } catch (e) {
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        wsReconnectAttempt = 0;
        setConnState('connected');
        log('✅ Connected to Nebulux server', 'success');
    };

    ws.onclose = () => {
        setConnState('disconnected');
        scheduleReconnect();
    };

    ws.onerror = () => { setConnState('disconnected'); };

    ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch {
            console.warn('Ignored malformed WS message:', event.data);
            return;
        }
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
            console.warn('Ignored WS message without type field');
            return;
        }
        handleServerMessage(data);
    };
}

function scheduleReconnect() {
    wsReconnectAttempt++;
    const delay = Math.min(WS_MAX_BACKOFF, 1000 * Math.pow(2, Math.min(wsReconnectAttempt, 5)));
    setTimeout(connectWS, delay);
}

function handleServerMessage(data) {
    switch(data.type) {
        case 'connected':
            log('🛰️ ' + data.msg, 'info');
            break;
        case 'log':
            log(data.msg, data.logType || 'agent');
            break;
        case 'agent_status':
            setAgentState(data.agent, data.status);
            break;
        case 'progress':
            setProgress(data.agent, data.percent);
            break;
        case 'arrow':
            setArrowState(data.index, data.status);
            break;
        case 'pipeline_order':
            applyPipelineOrder(data.order || [], !!data.parallel, data.skipped || []);
            break;
        case 'complete':
            isRunning = false;
            setRunningState(false);
            bumpRunCount();
            refreshStats();
            log('✨ Pipeline complete! Check the /output folder for generated files.', 'success');
            break;
        case 'error':
            isRunning = false;
            setRunningState(false);
            const provider = data.provider ? ` (${getModelLabel(data.provider)})` : '';
            log(`❌ Error${provider}: ${data.error}`, 'error');
            if (data.status === 429) {
                log('💡 Tip: pick a different model in the dropdown for that stage, or wait for the quota to reset.', 'info');
            }
            break;
    }
}

// ===== UI FUNCTIONS =====
function setAgentState(id, state) {
    const card = document.getElementById(`agent-${id}`);
    if (!card) return;
    // Preserve `parallel` and `skipped` modifier classes that aren't tied to status
    const wasParallel = card.classList.contains('parallel');
    const wasSkipped = card.classList.contains('skipped');
    card.className = `agent-card ${id==='supervisor'?'supervisor':'agent'} ${state}`;
    if (wasParallel) card.classList.add('parallel');
    if (wasSkipped || state === 'skipped') card.classList.add('skipped');
    const statusEl = document.getElementById(`status-${id}`);
    if (statusEl) {
        const labels = { idle: 'Idle', active: 'Working...', done: 'Complete ✓', error: 'Error ✗', skipped: 'Skipped' };
        statusEl.textContent = labels[state] || state;
    }
    if (selectedAgent === id) renderDetail(id);
}

// FLIP-animated pipeline reorder based on Planner's decision.
// `order` = stages between Planner and DevOps in execution order, e.g. ['coder', 'designer'] or ['coder']
// `parallel` = true if order items run concurrently
// `skipped` = stages that are NOT in order (will be hidden / dimmed)
function applyPipelineOrder(order, parallel, skipped) {
    const row = document.querySelector('.agent-row');
    if (!row) return;
    const cards = Array.from(row.querySelectorAll('.agent-card'));
    const arrows = Array.from(row.querySelectorAll('.flow-arrow'));

    // 1) Capture FIRST positions
    const firsts = new Map();
    cards.forEach(c => firsts.set(c.dataset.agent, c.getBoundingClientRect()));

    // 2) Compute new logical position for each card
    // Supervisor is always first, DevOps always last; Planner is always second.
    // Designer/Coder swap or hide based on the order argument.
    const fullSequence = ['supervisor', 'planner', ...order, 'devops'];
    cards.forEach(c => {
        const stage = c.dataset.agent;
        c.classList.remove('parallel', 'skipped');
        const idx = fullSequence.indexOf(stage);
        if (idx === -1) {
            c.classList.add('skipped');
            c.style.order = String(99 + cards.indexOf(c));
            const badge = c.querySelector('.agent-step');
            if (badge) badge.textContent = '–';
        } else {
            c.style.order = String(idx * 10);
            const badge = c.querySelector('.agent-step');
            // Supervisor has no step badge; Planner is step 1, others follow
            if (badge && stage !== 'supervisor') badge.textContent = String(idx);
        }
    });
    if (parallel) {
        order.forEach(s => {
            const card = document.querySelector(`.agent-card[data-agent="${s}"]`);
            if (card) card.classList.add('parallel');
        });
    }

    // 3) Arrows: keep one arrow between each adjacent visible stage.
    // We have 3 arrows in the DOM. We need (fullSequence.length - 1) of them shown.
    const arrowsNeeded = fullSequence.length - 1;
    arrows.forEach((arrow, i) => {
        if (i < arrowsNeeded) {
            arrow.style.display = '';
            arrow.style.order = String((i * 10) + 5);
            arrow.classList.toggle('parallel-arrow', parallel && i === 0 && order.length > 1);
        } else {
            arrow.style.display = 'none';
        }
    });

    // 4) FLIP: animate from first → last positions
    cards.forEach(c => {
        if (c.classList.contains('skipped')) return;
        const last = c.getBoundingClientRect();
        const first = firsts.get(c.dataset.agent);
        if (!first) return;
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        c.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration: 550, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.0)', fill: 'both' }
        );
    });

    log(`🧭 Pipeline order: planner → ${order.join(parallel ? ' ∥ ' : ' → ')} → devops${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`, 'supervisor');
    requestAnimationFrame(drawConnectors);
}

// Reset the pipeline visual order back to default (planner, designer, coder, devops, sequential).
function resetPipelineOrder() {
    const cards = document.querySelectorAll('.agent-row .agent-card');
    const defaults = { planner: 1, designer: 2, coder: 3, devops: 4 };
    cards.forEach(c => {
        c.classList.remove('parallel', 'skipped');
        c.style.order = '';
        c.style.display = '';
        const badge = c.querySelector('.agent-step');
        const stage = c.dataset.agent;
        if (badge && defaults[stage]) badge.textContent = String(defaults[stage]);
    });
    // Restore any arrows hidden/reordered by a previous skipped or parallel run
    document.querySelectorAll('.agent-row .flow-arrow').forEach(a => {
        a.style.display = '';
        a.style.order = '';
        a.classList.remove('parallel-arrow');
    });
    requestAnimationFrame(drawConnectors);
}

// ===== SIDEBAR NAV + SIMPLE MODALS =====
function openModal(id) { const el = document.getElementById(id); if (el) el.hidden = false; }
function closeModal(id) { const el = document.getElementById(id); if (el) el.hidden = true; }

function renderHistory() {
    const list = document.getElementById('history-list');
    const empty = document.getElementById('history-empty');
    if (!list) return;
    const items = loadHistory();
    list.innerHTML = '';
    if (!items.length) { empty.hidden = false; return; }
    empty.hidden = true;
    items.forEach(it => {
        const li = document.createElement('li');
        li.className = 'history-item';
        const desc = document.createElement('div');
        desc.className = 'history-desc';
        desc.textContent = it.desc;
        const meta = document.createElement('div');
        meta.className = 'history-meta';
        meta.textContent = new Date(it.ts).toLocaleString();
        li.append(desc, meta);
        li.addEventListener('click', () => {
            document.getElementById('project-desc').value = it.desc;
            closeModal('history-modal');
            log(`📋 Loaded a past project from history.`, 'info');
        });
        list.appendChild(li);
    });
}

function wireSidebar() {
    document.querySelectorAll('.sidebar [data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'settings') openSettings();
            else if (action === 'check-apis') runApiCheck();
            else if (action === 'history') { renderHistory(); openModal('history-modal'); }
            else if (action === 'about') openModal('about-modal');
            else if (action === 'license') openModal('license-modal');
        });
    });
    // Close buttons & backdrops for the new modals
    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    ['history-modal','about-modal','license-modal'].forEach(id => {
        const m = document.getElementById(id);
        if (!m) return;
        m.addEventListener('click', e => { if (e.target === m) closeModal(id); });
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        ['history-modal','about-modal','license-modal'].forEach(id => {
            const m = document.getElementById(id); if (m && !m.hidden) closeModal(id);
        });
    });
    // Clear history
    const clearBtn = document.getElementById('history-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
        if (!confirm('Clear all pipeline history from this browser?')) return;
        localStorage.removeItem(HISTORY_STORAGE);
        renderHistory();
        refreshStats();
        log('🗑 History cleared.', 'info');
    });
}

// Live char counter for project description
function wireCharCounter() {
    const ta = document.getElementById('project-desc');
    const counter = document.getElementById('char-counter');
    if (!ta || !counter) return;
    const update = () => { counter.textContent = `${ta.value.length} / 8000`; };
    ta.addEventListener('input', update);
    update();
}

function setProgress(id, pct) {
    const bar = document.getElementById(`progress-${id}`);
    if (bar) bar.style.width = Math.min(100, pct) + '%';
}

function setArrowState(idx, state) {
    const arrow = document.getElementById(`arrow-${idx}`);
    if (arrow) arrow.className = `flow-arrow ${state}`;
}

function log(msg, type = 'info') {
    const time = new Date().toTimeString().slice(0, 8);
    const div = document.createElement('div');
    div.className = `log-entry log-${type}`;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = time;
    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg';
    msgSpan.textContent = String(msg);
    div.append(timeSpan, msgSpan);
    logBody.appendChild(div);
    // Cap log size so a long run doesn't grow unbounded
    while (logBody.childElementCount > 500) logBody.removeChild(logBody.firstChild);
    logBody.scrollTop = logBody.scrollHeight;
}

function renderDetail(agentId) {
    selectedAgent = agentId;
    const a = AGENTS[agentId];
    const sel = document.querySelector(`.model-select[data-stage="${agentId}"]`);
    const chosenLabel = sel ? getModelLabel(sel.value) : null;
    detailTitle.textContent = chosenLabel ? `${a.name} — ${chosenLabel}` : a.name;
    detailDesc.textContent = chosenLabel ? `${a.desc}\n\nCurrent model: ${chosenLabel}.` : a.desc;
    document.querySelectorAll('.agent-card').forEach(c => c.classList.toggle('selected', c.dataset.agent === agentId));
}

function resetAll() {
    resetPipelineOrder();
    ['supervisor',...PIPELINE].forEach(id => setAgentState(id, 'idle'));
    PIPELINE.forEach(id => setProgress(id, 0));
    [0,1,2].forEach(i => setArrowState(i, ''));
    logBody.innerHTML = '';
    log('System reset. Ready for next run.', 'info');
    renderDetail('supervisor');
}

// ===== RUN PIPELINE =====
// Keep every run trigger in sync (top-bar "Run Pipeline" + below-prompt "Build").
function setRunningState(on) {
    document.querySelectorAll('#btn-run, #btn-build').forEach(b => {
        b.classList.toggle('running', on);
        const span = b.querySelector('span');
        if (span) span.textContent = on
            ? (b.dataset.runningLabel || 'Running...')
            : (b.dataset.idleLabel || 'Run Pipeline');
    });
}

async function runPipeline() {
    if (isRunning) return;
    if (!hasAnyKey()) {
        log('⚠️ Add at least one API key in Settings before running.', 'error');
        openSettings();
        return;
    }
    const desc = document.getElementById('project-desc').value.trim();
    if (!desc) { alert('Please describe your project first!'); return; }

    isRunning = true;
    resetAll();
    addHistory(desc);
    refreshStats();
    setRunningState(true);
    log(`🚀 Starting pipeline for: "${desc.slice(0, 80)}..."`, 'supervisor');

    try {
        const models = getModelSelections();
        const summary = STAGES.map(s => `${s}=${getModelLabel(models[s])}`).join(', ');
        log(`🔀 Models: ${summary}`, 'info');

        const res = await fetch(`${API_BASE}/api/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getKeyHeaders() },
            body: JSON.stringify({ projectDescription: desc, models, customModels: loadCustomModels() })
        });
        const data = await res.json();
        if (data.error) { log('❌ ' + data.error, 'error'); isRunning = false; setRunningState(false); }
    } catch (e) {
        log('❌ Failed to connect to server. Is it running?', 'error');
        isRunning = false;
        setRunningState(false);
    }
}

// ===== API HEALTH CHECK =====
const apiModal = document.getElementById('api-modal');
// Header button was removed in the dashboard redesign — Check APIs is now a sidebar nav item.
// We keep a no-op proxy so legacy references don't throw.
const btnCheckApis = document.getElementById('btn-check-apis') || {
    classList: { add() {}, remove() {} },
    addEventListener() {}
};

function setProviderRow(provider, state, message, latency) {
    const row = document.querySelector(`.api-row[data-provider="${provider}"]`);
    if (!row) return;
    row.classList.remove('ok', 'error', 'warn');
    const dot = row.querySelector('.api-dot');
    dot.classList.remove('pending', 'checking', 'ok', 'error', 'warn');
    const msg = row.querySelector('.api-msg');
    const lat = row.querySelector('.api-latency');

    if (state === 'checking') {
        dot.classList.add('checking');
        msg.textContent = 'Pinging…';
        lat.textContent = '';
    } else if (state === 'ok') {
        row.classList.add('ok');
        dot.classList.add('ok');
        msg.textContent = message || 'Connected';
        lat.textContent = latency != null ? `${latency} ms` : '';
    } else if (state === 'warn') {
        row.classList.add('warn');
        dot.classList.add('warn');
        msg.textContent = message || 'Reachable with warnings';
        lat.textContent = latency != null ? `${latency} ms` : '';
    } else {
        row.classList.add('error');
        dot.classList.add('error');
        msg.textContent = message || 'Connection failed';
        lat.textContent = latency != null ? `${latency} ms` : '';
    }
}

function openApiModal() {
    apiModal.hidden = false;
    document.getElementById('api-summary').classList.remove('show', 'ok', 'error');
    document.getElementById('api-summary').textContent = '';
    // Reset to just the built-in rows then add one row per custom model
    const list = document.getElementById('api-list');
    Array.from(list.querySelectorAll('.api-row[data-custom="1"]')).forEach(el => el.remove());
    const customs = loadCustomModels();
    customs.forEach(m => {
        const li = document.createElement('li');
        li.className = 'api-row';
        li.dataset.provider = `custom:${m.id}`;
        li.dataset.custom = '1';
        const dot = document.createElement('span'); dot.className = 'api-dot pending';
        const info = document.createElement('div'); info.className = 'api-info';
        const name = document.createElement('div'); name.className = 'api-name';
        name.append('⚡ ', m.name, ' ');
        const sub = document.createElement('span'); sub.className = 'api-sub'; sub.textContent = 'Custom';
        name.appendChild(sub);
        const msg = document.createElement('div'); msg.className = 'api-msg'; msg.textContent = 'Waiting…';
        info.append(name, msg);
        const lat = document.createElement('span'); lat.className = 'api-latency';
        li.append(dot, info, lat);
        list.appendChild(li);
    });
    ['claude','gemini','kimi','ollama', ...customs.map(m => `custom:${m.id}`)].forEach(p => setProviderRow(p, 'checking'));
    document.getElementById('api-modal-hint').textContent = 'Pinging each provider with a tiny request to verify connectivity…';
}

function closeApiModal() { apiModal.hidden = true; }

async function runApiCheck() {
    btnCheckApis.classList.remove('all-ok', 'has-error');
    btnCheckApis.classList.add('checking');
    openApiModal();
    log('🔌 Checking API connectivity for all providers...', 'info');

    try {
        const res = await fetch(`${API_BASE}/api/health/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getKeyHeaders() },
            body: JSON.stringify({ customModels: loadCustomModels() })
        });
        const data = await res.json();
        const providers = data.providers || {};

        for (const [name, info] of Object.entries(providers)) {
            const state = info.ok ? (info.warn ? 'warn' : 'ok') : 'error';
            setProviderRow(name, state, info.message, info.latency);
            const icon = info.ok ? (info.warn ? '⚠️' : '✅') : '❌';
            log(`${icon} ${name}: ${info.message}`, info.ok ? 'success' : 'error');
        }

        const summary = document.getElementById('api-summary');
        summary.classList.add('show');
        if (data.allOk) {
            summary.classList.add('ok');
            summary.textContent = '✅ All APIs are connected and working fine.';
            btnCheckApis.classList.add('all-ok');
        } else {
            summary.classList.add('error');
            const failed = Object.entries(providers).filter(([_, v]) => !v.ok).map(([k]) => k).join(', ');
            summary.textContent = `❌ Issues detected with: ${failed}. Check your .env keys & service status.`;
            btnCheckApis.classList.add('has-error');
        }
        document.getElementById('api-modal-hint').textContent = `Checked at ${new Date(data.checkedAt).toLocaleTimeString()}`;
    } catch (e) {
        ['claude','gemini','kimi','ollama'].forEach(p => setProviderRow(p, 'error', 'Server unreachable'));
        const summary = document.getElementById('api-summary');
        summary.classList.add('show', 'error');
        summary.textContent = '❌ Could not reach the Nebulux server. Is it running?';
        btnCheckApis.classList.add('has-error');
        log('❌ API health check failed: ' + e.message, 'error');
    } finally {
        btnCheckApis.classList.remove('checking');
    }
}

// ===== STATS + HISTORY =====
const RUNS_STORAGE = 'nebulux.runs.v1';
const HISTORY_STORAGE = 'nebulux.history.v1';
const HISTORY_LIMIT = 25;

function getRunCount() {
    return Number(localStorage.getItem(RUNS_STORAGE) || 0);
}
function bumpRunCount() {
    const n = getRunCount() + 1;
    localStorage.setItem(RUNS_STORAGE, String(n));
    return n;
}
function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_STORAGE) || '[]') || []; } catch { return []; }
}
function saveHistory(list) { localStorage.setItem(HISTORY_STORAGE, JSON.stringify(list.slice(0, HISTORY_LIMIT))); }
function addHistory(desc) {
    const list = loadHistory();
    list.unshift({ desc, ts: Date.now() });
    saveHistory(list);
}

function refreshStats() {
    document.getElementById('stat-runs').textContent = String(getRunCount());
    const k = loadKeys();
    const customs = loadCustomModels();
    let count = 0;
    if (k.anthropic) count++;
    if (k.gemini) count++;
    if (k.kimi || k.kimiUrl) count++;
    if (k.ollamaUrl) count++;
    count += customs.length;
    document.getElementById('stat-models').textContent = String(count);
    const sub = document.getElementById('stat-models-sub');
    if (sub) sub.textContent = count === 0 ? 'Add keys in Settings →' : (customs.length ? `${customs.length} custom · ${count - customs.length} provider` : `${count} provider${count === 1 ? '' : 's'}`);
    // History badge
    const badge = document.getElementById('history-count');
    const h = loadHistory().length;
    if (badge) {
        if (h > 0) { badge.hidden = false; badge.textContent = String(h); }
        else { badge.hidden = true; }
    }
}

// ===== SVG CONNECTORS (input card → agent cards) =====
function drawConnectors() {
    const svg = document.getElementById('pipeline-connectors');
    if (!svg) return;
    const section = svg.parentElement;
    const cards = Array.from(document.querySelectorAll('.agent-row .agent-card')).filter(c => c.style.display !== 'none');
    if (!cards.length) { svg.innerHTML = ''; return; }
    const sectionRect = section.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${sectionRect.width} 46`);
    svg.style.width = sectionRect.width + 'px';
    const trunkY = 22;
    const branchY = 46;
    // Sort cards by their visual order
    const positions = cards
        .map(c => {
            const r = c.getBoundingClientRect();
            return { x: r.left - sectionRect.left + r.width / 2, card: c };
        })
        .sort((a, b) => a.x - b.x);
    if (!positions.length) { svg.innerHTML = ''; return; }
    const minX = positions[0].x;
    const maxX = positions[positions.length - 1].x;
    const midX = sectionRect.width / 2;
    let parts = [];
    // Vertical from input center down to trunk
    parts.push(`<path d="M ${midX} 0 V ${trunkY}" />`);
    // Trunk horizontal line
    parts.push(`<path d="M ${minX} ${trunkY} H ${maxX}" />`);
    // Branches down to each card
    for (const p of positions) {
        parts.push(`<path d="M ${p.x} ${trunkY} V ${branchY}" />`);
        parts.push(`<circle cx="${p.x}" cy="${trunkY}" r="2.5" />`);
    }
    // Center junction dot
    parts.push(`<circle cx="${midX}" cy="${trunkY}" r="3" />`);
    svg.innerHTML = parts.join('');
}

// ===== CUSTOM MODELS (OpenAI-compatible) =====
const CUSTOM_MODELS_STORAGE = 'nebulux.customModels.v1';

function loadCustomModels() {
    try {
        const arr = JSON.parse(localStorage.getItem(CUSTOM_MODELS_STORAGE) || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function saveCustomModels(list) {
    localStorage.setItem(CUSTOM_MODELS_STORAGE, JSON.stringify(list));
}
function upsertCustomModel(model) {
    const list = loadCustomModels();
    if (model.id) {
        const idx = list.findIndex(m => m.id === model.id);
        if (idx >= 0) { list[idx] = model; saveCustomModels(list); return; }
    }
    model.id = 'cm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    list.push(model);
    saveCustomModels(list);
}
function deleteCustomModel(id) {
    saveCustomModels(loadCustomModels().filter(m => m.id !== id));
    // Reset any dropdowns currently pointing to the deleted model
    document.querySelectorAll('.model-select').forEach(sel => {
        if (sel.value === `custom:${id}`) {
            sel.value = MODEL_DEFAULTS[sel.dataset.stage] || 'claude';
        }
    });
    saveModelSelections();
}
function getCustomModelById(id) {
    return loadCustomModels().find(m => m.id === id);
}
function getModelLabel(value) {
    if (!value) return '';
    if (MODEL_LABELS[value]) return MODEL_LABELS[value];
    if (value.startsWith('custom:')) {
        const m = getCustomModelById(value.slice('custom:'.length));
        return m ? `⚡ ${m.name}` : '⚡ Custom (deleted)';
    }
    return value;
}

function renderCustomModelsList() {
    const list = loadCustomModels();
    const container = document.getElementById('custom-models-list');
    if (!container) return;
    container.innerHTML = '';
    list.forEach(m => {
        const row = document.createElement('div');
        row.className = 'custom-model-item';
        const info = document.createElement('div');
        info.className = 'custom-model-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'custom-model-name';
        nameEl.textContent = m.name;
        const metaEl = document.createElement('div');
        metaEl.className = 'custom-model-meta';
        metaEl.textContent = `${m.baseUrl} • ${m.model}`;
        info.append(nameEl, metaEl);
        const actions = document.createElement('div');
        actions.className = 'custom-model-actions';
        const editBtn = document.createElement('button');
        editBtn.type = 'button'; editBtn.textContent = '✏'; editBtn.title = 'Edit';
        editBtn.addEventListener('click', () => openCustomForm(m));
        const delBtn = document.createElement('button');
        delBtn.type = 'button'; delBtn.textContent = '🗑'; delBtn.title = 'Delete'; delBtn.className = 'delete';
        delBtn.addEventListener('click', () => {
            if (!confirm(`Delete custom model "${m.name}"?`)) return;
            deleteCustomModel(m.id);
            renderCustomModelsList();
            refreshModelDropdowns();
            refreshStats();
            log(`🗑 Custom model "${m.name}" removed.`, 'info');
        });
        actions.append(editBtn, delBtn);
        row.append(info, actions);
        container.appendChild(row);
    });
}

function openCustomForm(model) {
    const form = document.getElementById('custom-model-form');
    document.getElementById('custom-id').value = model?.id || '';
    document.getElementById('custom-name').value = model?.name || '';
    document.getElementById('custom-baseurl').value = model?.baseUrl || '';
    document.getElementById('custom-model').value = model?.model || '';
    document.getElementById('custom-key').value = model?.apiKey || '';
    form.hidden = false;
    document.getElementById('custom-name').focus();
}
function closeCustomForm() {
    document.getElementById('custom-model-form').hidden = true;
}

function refreshModelDropdowns() {
    const customs = loadCustomModels();
    document.querySelectorAll('.model-select').forEach(sel => {
        const currentValue = sel.value;
        // Remove old custom options (keep first 4 built-ins)
        Array.from(sel.querySelectorAll('option[data-custom="1"]')).forEach(o => o.remove());
        customs.forEach(m => {
            const opt = document.createElement('option');
            opt.value = `custom:${m.id}`;
            opt.textContent = `⚡ ${m.name}`;
            opt.dataset.custom = '1';
            sel.appendChild(opt);
        });
        // Restore previous selection if still valid
        if ([...sel.options].some(o => o.value === currentValue)) {
            sel.value = currentValue;
        } else {
            sel.value = MODEL_DEFAULTS[sel.dataset.stage] || 'claude';
        }
    });
}

// ===== SETTINGS / BYOK =====
const KEYS_STORAGE = 'nebulux.keys.v1';
const KEY_FIELDS = {
    anthropic: 'key-anthropic',
    gemini: 'key-gemini',
    kimiUrl: 'key-kimi-url',
    kimi: 'key-kimi',
    ollamaUrl: 'key-ollama-url',
    ollamaModel: 'key-ollama-model'
};

function loadKeys() {
    try { return JSON.parse(localStorage.getItem(KEYS_STORAGE) || '{}') || {}; } catch { return {}; }
}
function saveKeysObj(obj) { localStorage.setItem(KEYS_STORAGE, JSON.stringify(obj)); }
function clearKeysStorage() { localStorage.removeItem(KEYS_STORAGE); }
function hasAnyKey() {
    const k = loadKeys();
    // A local Kimi NIM or Ollama needs only a URL (no auth key), so a configured
    // URL alone counts as a usable provider. Custom models count too. Server-side
    // .env keys also count — the pipeline falls back to them when no BYOK keys exist.
    return !!(k.anthropic || k.gemini || k.kimi || k.kimiUrl || k.ollamaUrl || loadCustomModels().length || serverHasKeys);
}

// Ask the server whether it has any provider key configured via .env, so a locally
// run instance with keys in .env enables the Build/Run buttons without forcing BYOK.
async function refreshServerKeys() {
    try {
        const r = await fetch(`${API_BASE}/api/health`);
        const d = await r.json();
        serverHasKeys = !!(d.apis && (d.apis.claude || d.apis.gemini || d.apis.kimi));
    } catch { serverHasKeys = false; }
    gateRunButton();
}

function getKeyHeaders() {
    const k = loadKeys();
    const h = {};
    if (k.anthropic) h['X-Anthropic-Key'] = k.anthropic;
    if (k.gemini) h['X-Gemini-Key'] = k.gemini;
    if (k.kimi) h['X-Kimi-Key'] = k.kimi;
    if (k.kimiUrl) h['X-Kimi-Url'] = k.kimiUrl;
    if (k.ollamaUrl) h['X-Ollama-Url'] = k.ollamaUrl;
    if (k.ollamaModel) h['X-Ollama-Model'] = k.ollamaModel;
    return h;
}

function populateSettingsForm() {
    const k = loadKeys();
    for (const [field, id] of Object.entries(KEY_FIELDS)) {
        const el = document.getElementById(id);
        if (el) el.value = k[field] || '';
    }
    updateSettingsSummary();
}

function readSettingsForm() {
    const out = {};
    for (const [field, id] of Object.entries(KEY_FIELDS)) {
        const el = document.getElementById(id);
        if (el && el.value.trim()) out[field] = el.value.trim();
    }
    return out;
}

function updateSettingsSummary() {
    const k = loadKeys();
    const present = [
        k.anthropic && 'Claude',
        k.gemini && 'Gemini',
        (k.kimi || k.kimiUrl) && 'Kimi',
        (k.ollamaUrl || k.ollamaModel) && 'Gemma'
    ].filter(Boolean);
    const summary = document.getElementById('settings-summary');
    if (!summary) return;
    if (present.length) {
        summary.className = 'settings-summary show ok';
        summary.textContent = `✓ Configured: ${present.join(', ')}`;
    } else {
        summary.className = 'settings-summary show error';
        summary.textContent = '⚠️ No keys saved yet — add at least one to run the pipeline.';
    }
}

function openSettings() {
    populateSettingsForm();
    renderCustomModelsList();
    closeCustomForm();
    document.getElementById('settings-modal').hidden = false;
}
function closeSettings() {
    document.getElementById('settings-modal').hidden = true;
}

function gateRunButton() {
    // The sidebar Settings nav item pulses red when keys are missing
    const settingsNav = document.querySelector('.sidebar [data-action="settings"]');
    const enabled = hasAnyKey();
    document.querySelectorAll('#btn-run, #btn-build').forEach(btn => {
        btn.classList.toggle('disabled', !enabled);
        if (enabled) {
            btn.removeAttribute('disabled');
            btn.title = btn.id === 'btn-build'
                ? 'Build your project with the multi-agent pipeline'
                : 'Run the multi-agent pipeline';
        } else {
            btn.setAttribute('disabled', 'disabled');
            btn.title = 'Add API keys in Settings first';
        }
    });
    if (settingsNav) settingsNav.classList.toggle('needs-keys', !enabled);
}

function wireSettingsModal() {
    // Settings button is in the sidebar nav now (wired by wireSidebar)
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-cancel').addEventListener('click', closeSettings);

    document.getElementById('settings-save').addEventListener('click', () => {
        const next = readSettingsForm();
        saveKeysObj(next);
        updateSettingsSummary();
        gateRunButton();
        refreshStats();
        log('🔑 API keys saved to your browser.', 'success');
        closeSettings();
    });

    document.getElementById('settings-clear').addEventListener('click', () => {
        if (!confirm('Clear all saved API keys from this browser?')) return;
        clearKeysStorage();
        populateSettingsForm();
        gateRunButton();
        refreshStats();
        log('🗑 API keys cleared from this browser.', 'info');
    });

    // Custom model add/edit form
    document.getElementById('btn-add-custom').addEventListener('click', () => openCustomForm(null));
    document.getElementById('custom-form-cancel').addEventListener('click', closeCustomForm);
    document.getElementById('custom-form-save').addEventListener('click', () => {
        const model = {
            id: document.getElementById('custom-id').value.trim() || undefined,
            name: document.getElementById('custom-name').value.trim(),
            baseUrl: document.getElementById('custom-baseurl').value.trim().replace(/\/+$/, ''),
            model: document.getElementById('custom-model').value.trim(),
            apiKey: document.getElementById('custom-key').value.trim()
        };
        if (!model.name || !model.baseUrl || !model.model) {
            alert('Display name, Base URL, and Model ID are required.');
            return;
        }
        if (!/^https?:\/\//i.test(model.baseUrl)) {
            alert('Base URL must start with http:// or https://');
            return;
        }
        upsertCustomModel(model);
        renderCustomModelsList();
        refreshModelDropdowns();
        refreshStats();
        closeCustomForm();
        log(`⚡ Custom model "${model.name}" saved.`, 'success');
    });

    // Show/hide password toggles
    document.querySelectorAll('.key-eye').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.toggle;
            const input = document.getElementById(targetId);
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
            btn.textContent = input.type === 'password' ? '👁' : '🙈';
        });
    });

    // Close on backdrop click + Escape
    const modal = document.getElementById('settings-modal');
    modal.addEventListener('click', e => { if (e.target === modal) closeSettings(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeSettings(); });
}

// ===== MODEL SELECTION =====
function getModelSelections() {
    const out = {};
    document.querySelectorAll('.model-select').forEach(sel => {
        out[sel.dataset.stage] = sel.value;
    });
    return out;
}

function loadModelSelections() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('nebulux.models') || '{}'); } catch { saved = {}; }
    document.querySelectorAll('.model-select').forEach(sel => {
        const stage = sel.dataset.stage;
        sel.value = saved[stage] || MODEL_DEFAULTS[stage] || 'claude';
    });
}

function saveModelSelections() {
    localStorage.setItem('nebulux.models', JSON.stringify(getModelSelections()));
}

function refreshDetailIfRelevant(stage) {
    if (selectedAgent === stage) renderDetail(stage);
}

document.querySelectorAll('.model-select').forEach(sel => {
    // Don't bubble clicks/changes up to the card (which would re-render the detail panel)
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', e => {
        e.stopPropagation();
        const stage = sel.dataset.stage;
        saveModelSelections();
        log(`🔀 ${stage[0].toUpperCase()+stage.slice(1)} model set to ${getModelLabel(sel.value)}`, 'info');
        refreshDetailIfRelevant(stage);
    });
});

// ===== EVENTS =====
document.querySelectorAll('.agent-card').forEach(c => c.addEventListener('click', () => renderDetail(c.dataset.agent)));
document.getElementById('btn-run').addEventListener('click', runPipeline);
const _btnBuild = document.getElementById('btn-build');
if (_btnBuild) _btnBuild.addEventListener('click', runPipeline);
document.getElementById('btn-reset').addEventListener('click', resetAll);
document.getElementById('btn-clear-log').addEventListener('click', () => { logBody.innerHTML = ''; });
document.getElementById('api-modal-close').addEventListener('click', closeApiModal);
document.getElementById('api-modal-done').addEventListener('click', closeApiModal);
document.getElementById('api-modal-recheck').addEventListener('click', runApiCheck);
apiModal.addEventListener('click', (e) => { if (e.target === apiModal) closeApiModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !apiModal.hidden) closeApiModal(); });

// Init
const yearEl = document.getElementById('footer-year');
if (yearEl) yearEl.textContent = new Date().getFullYear();
refreshModelDropdowns();
loadModelSelections();
wireSettingsModal();
wireSidebar();
wireCharCounter();
gateRunButton();
refreshStats();
renderDetail('supervisor');
connectWS();

// Initial connector draw + redraw on resize
requestAnimationFrame(drawConnectors);
let _resizeT;
window.addEventListener('resize', () => {
    clearTimeout(_resizeT);
    _resizeT = setTimeout(drawConnectors, 80);
});

// Check server .env keys, then re-gate buttons and decide onboarding.
// If neither the browser nor the server has any key, prompt for BYOK setup.
refreshServerKeys().then(() => {
    if (!hasAnyKey()) {
        openSettings();
        log('👋 Welcome to Nebulux. Add your API keys to get started.', 'info');
    } else if (serverHasKeys) {
        log('🔑 Using API keys from the server\'s .env — ready to build.', 'info');
    }
});
