const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');

const VALID_MODELS = ['claude', 'gemini', 'kimi', 'gemma'];

class ModelRouter {
    constructor(config) {
        this.anthropic = config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null;
        this.gemini = config.geminiKey ? new GoogleGenAI({ apiKey: config.geminiKey }) : null;
        this.kimiUrl = (config.kimiUrl || 'http://localhost:8000').replace(/\/+$/, '');
        this.kimiKey = config.kimiKey;
        this.ollamaUrl = (config.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
        this.ollamaModel = config.ollamaModel || 'gemma3:latest';
        // Optional AbortSignal — set by the orchestrator so the Stop button can
        // abort in-flight provider requests. Undefined = no cancellation.
        this.signal = config.signal;
        // Custom OpenAI-compatible models, keyed by id: { id, name, baseUrl, model, apiKey }
        this.customModels = new Map();
        if (Array.isArray(config.customModels)) {
            for (const m of config.customModels) {
                if (m && m.id && m.baseUrl && m.model) {
                    this.customModels.set(m.id, {
                        id: m.id,
                        name: m.name || m.id,
                        baseUrl: String(m.baseUrl).replace(/\/+$/, ''),
                        model: m.model,
                        apiKey: m.apiKey || ''
                    });
                }
            }
        }
    }

    static normalize(name) {
        if (!name) return null;
        const raw = String(name).trim();
        if (raw.startsWith('custom:')) return raw; // pass-through, ID is opaque
        const k = raw.toLowerCase();
        if (k.startsWith('claude') || k === 'anthropic') return 'claude';
        if (k.startsWith('gemini') || k === 'google') return 'gemini';
        if (k.startsWith('kimi') || k === 'moonshot') return 'kimi';
        if (k.startsWith('gemma') || k === 'ollama') return 'gemma';
        return VALID_MODELS.includes(k) ? k : null;
    }

    label(model) {
        if (typeof model === 'string' && model.startsWith('custom:')) {
            const m = this.customModels?.get(model.slice('custom:'.length));
            return m ? `⚡ ${m.name}` : '⚡ Custom (unknown)';
        }
        return { claude: 'Claude', gemini: 'Gemini', kimi: 'Kimi K2.6', gemma: 'Gemma 3' }[model] || model;
    }

    // Peel a single fence ONLY when the whole response is wrapped in one
    // ```lang ... ``` block. Never strips fences globally, so markdown/README
    // output that legitimately contains code blocks is left intact.
    stripFences(text) {
        const t = (text || '').trim();
        const wrapped = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
        return wrapped ? wrapped[1].trim() : t;
    }

    async chat(model, { system, prompt, maxTokens = 4000 }) {
        const m = ModelRouter.normalize(model) || 'claude';
        const fn = () => {
            if (typeof m === 'string' && m.startsWith('custom:')) {
                return this.customChat(m.slice('custom:'.length), system, prompt, maxTokens);
            }
            switch (m) {
                case 'claude': return this.claudeChat(system, prompt, maxTokens);
                case 'gemini': return this.geminiChat(system, prompt, maxTokens);
                case 'kimi':   return this.kimiChat(system, prompt, maxTokens);
                case 'gemma':  return this.gemmaChat(system, prompt, maxTokens);
            }
        };
        return this.withRetry(m, fn);
    }

    // Generic OpenAI-compatible chat call — works for DeepSeek, Groq, OpenRouter, Together,
    // Mistral, local llama.cpp / vLLM / LM Studio, etc.
    async customChat(id, system, prompt, maxTokens) {
        const cfg = this.customModels.get(id);
        if (!cfg) throw new Error(`Custom model '${id}' is not configured. Add it in Settings.`);
        const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: prompt });
        const url = /\/chat\/completions\/?$/.test(cfg.baseUrl)
            ? cfg.baseUrl
            : `${cfg.baseUrl}/chat/completions`;
        const r = await axios.post(url, {
            model: cfg.model,
            messages,
            max_tokens: maxTokens
        }, { headers, timeout: 180000, signal: this.signal });
        const content = r?.data?.choices?.[0]?.message?.content;
        if (!content) throw new Error(`${cfg.name} returned no content`);
        return this.stripFences(content);
    }

    // Retry with backoff for transient errors (429, 503, network timeouts).
    // Throws a friendly Error after exhausting retries.
    async withRetry(modelName, fn, maxAttempts = 3) {
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                // Never retry once the pipeline has been stopped — surface immediately.
                if (this.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.name === 'APIUserAbortError') {
                    const e = new Error('Request aborted (pipeline stopped).');
                    e.aborted = true;
                    throw e;
                }
                const info = ModelRouter.classifyError(err);
                const isTransient = info.status === 429 || info.status === 503 || info.status === 502 || info.status === 504 || info.code === 'ECONNRESET' || info.code === 'ETIMEDOUT';
                if (!isTransient || attempt === maxAttempts) {
                    const friendly = new Error(`[${this.label(modelName)}] ${info.message}`);
                    friendly.provider = modelName;
                    friendly.status = info.status;
                    friendly.code = info.code;
                    throw friendly;
                }
                const waitMs = info.retryAfterMs || Math.min(30000, 1500 * Math.pow(2, attempt - 1));
                console.warn(`[${this.label(modelName)}] attempt ${attempt} failed (${info.status || info.code}): ${info.message} — retrying in ${Math.round(waitMs / 1000)}s`);
                await new Promise(r => setTimeout(r, waitMs));
            }
        }
        throw lastErr;
    }

    static classifyError(err) {
        // Anthropic SDK
        if (err?.status && err?.error?.error?.message) {
            return { status: err.status, message: err.error.error.message, code: err.error.error.type };
        }
        // Axios
        if (err?.response) {
            const status = err.response.status;
            const data = err.response.data || {};
            const apiMsg = data.error?.message || data.detail || data.message;
            const retryHeader = err.response.headers?.['retry-after'];
            const retryAfterMs = retryHeader ? Number(retryHeader) * 1000 : null;
            // Google quota detail
            let retryFromBody = null;
            if (Array.isArray(data.error?.details)) {
                const ri = data.error.details.find(d => (d['@type'] || '').includes('RetryInfo'));
                if (ri?.retryDelay) {
                    const m = String(ri.retryDelay).match(/(\d+(?:\.\d+)?)s/);
                    if (m) retryFromBody = Math.ceil(parseFloat(m[1]) * 1000);
                }
            }
            return { status, message: apiMsg || `HTTP ${status}`, retryAfterMs: retryAfterMs || retryFromBody };
        }
        // Google GenAI SDK throws errors with .message that often contains the JSON body
        const raw = err?.message || String(err);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                const e = parsed.error || parsed;
                let retryAfterMs = null;
                if (Array.isArray(e.details)) {
                    const ri = e.details.find(d => (d['@type'] || '').includes('RetryInfo'));
                    if (ri?.retryDelay) {
                        const m = String(ri.retryDelay).match(/(\d+(?:\.\d+)?)s/);
                        if (m) retryAfterMs = Math.ceil(parseFloat(m[1]) * 1000);
                    }
                }
                return { status: e.code || e.status, message: e.message || raw.slice(0, 160), retryAfterMs };
            } catch { /* fall through */ }
        }
        return { status: null, message: raw.slice(0, 200), code: err?.code };
    }

    async claudeChat(system, prompt, maxTokens) {
        if (!this.anthropic) throw new Error('Claude not configured (ANTHROPIC_API_KEY missing)');
        const r = await this.anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: maxTokens,
            ...(system ? { system } : {}),
            messages: [{ role: 'user', content: prompt }]
        }, this.signal ? { signal: this.signal } : undefined);
        const text = r?.content?.[0]?.text;
        if (!text) throw new Error('Claude returned no content');
        return text;
    }

    async geminiChat(system, prompt, _maxTokens) {
        if (!this.gemini) throw new Error('Gemini not configured (GEMINI_API_KEY missing)');
        const r = await this.gemini.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: system ? `${system}\n\n${prompt}` : prompt,
            ...(this.signal ? { config: { abortSignal: this.signal } } : {})
        });
        const text = r?.text;
        if (text == null || text === '') throw new Error('Gemini returned no content');
        return this.stripFences(text);
    }

    async kimiChat(system, prompt, maxTokens) {
        const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
        if (this.kimiKey) headers['Authorization'] = `Bearer ${this.kimiKey}`;
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: prompt });
        const r = await axios.post(`${this.kimiUrl}/v1/chat/completions`, {
            model: 'moonshotai/kimi-k2.6',
            messages,
            max_tokens: maxTokens
        }, { headers, timeout: 180000, signal: this.signal });
        const content = r?.data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('Kimi returned no content');
        return content;
    }

    async gemmaChat(system, prompt, maxTokens) {
        const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
        try {
            const r = await axios.post(`${this.ollamaUrl}/api/generate`, {
                model: this.ollamaModel,
                prompt: fullPrompt,
                stream: false,
                options: { temperature: 0.3, num_predict: Math.min(maxTokens, 4000) }
            }, { timeout: 180000, signal: this.signal });
            const text = r?.data?.response;
            if (text == null || text === '') throw new Error(`Ollama (${this.ollamaModel}) returned no content`);
            return this.stripFences(text);
        } catch (err) {
            if (err.response?.status === 404) {
                const e = new Error(`Ollama model '${this.ollamaModel}' is not installed locally. Run: ollama pull ${this.ollamaModel}`);
                e.response = { status: 404 };
                throw e;
            }
            if (err.code === 'ECONNREFUSED') {
                const e = new Error(`Ollama not running at ${this.ollamaUrl}. Start it with: ollama serve`);
                e.code = 'ECONNREFUSED';
                throw e;
            }
            throw err;
        }
    }
}

ModelRouter.VALID_MODELS = VALID_MODELS;
module.exports = ModelRouter;
