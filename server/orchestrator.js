const fs = require('fs');
const path = require('path');
const ModelRouter = require('./modelRouter');
const PlannerAgent = require('./agents/planner');
const DesignerAgent = require('./agents/designer');
const CoderAgent = require('./agents/coder');
const DevOpsAgent = require('./agents/devops');
const SupervisorAgent = require('./agents/supervisor');

const DEFAULT_MODELS = {
    planner: 'claude',
    designer: 'kimi',
    coder: 'gemma',
    devops: 'claude',
    supervisor: 'claude'
};

class Orchestrator {
    constructor(config) {
        // Defaults from server .env — used as fallback when client doesn't provide its own
        this.defaults = {
            anthropicKey: config.anthropicKey,
            geminiKey: config.geminiKey,
            kimiKey: config.kimiKey,
            kimiUrl: config.kimiUrl,
            ollamaUrl: config.ollamaUrl,
            ollamaModel: config.ollamaModel
        };
        this.outputDir = config.outputDir || path.join(__dirname, '..', 'output');
        this.broadcast = config.broadcast || (() => {});
        // Build a "default" router for cases where no client keys are given
        this.router = new ModelRouter(this.defaults);
        // How many times the Supervisor may auto-revise a stage before the pipeline halts.
        this.maxRevisions = Number.isFinite(config.maxRevisions) ? config.maxRevisions : 2;
        // Cancellation state for the Stop button
        this.cancelled = false;
        this.abortController = null;
    }

    // Requested by POST /api/stop. Aborts in-flight provider requests and signals
    // the run loop to halt at the next checkpoint.
    cancel() {
        this.cancelled = true;
        if (this.abortController) { try { this.abortController.abort(); } catch { /* already aborted */ } }
    }

    buildRouter(clientKeys, customModels) {
        const merged = {};
        for (const k of Object.keys(this.defaults)) {
            const fromClient = clientKeys?.[k];
            merged[k] = (typeof fromClient === 'string' && fromClient.length) ? fromClient : this.defaults[k];
        }
        if (Array.isArray(customModels)) merged.customModels = customModels;
        return new ModelRouter(merged);
    }

    resolveModels(input) {
        const out = { ...DEFAULT_MODELS };
        if (input && typeof input === 'object') {
            for (const stage of Object.keys(out)) {
                const norm = ModelRouter.normalize(input[stage]);
                if (norm) out[stage] = norm;
            }
        }
        return out;
    }

    // Reads plan.pipeline and returns a safe, validated execution plan.
    // Fallback default = sequential designer → coder (legacy behaviour).
    static resolvePipeline(plan) {
        const VALID = ['designer', 'coder'];
        let order = ['designer', 'coder'];
        let parallel = false;
        let rationale = '';

        const p = plan?.pipeline;
        if (p && typeof p === 'object') {
            if (Array.isArray(p.order)) {
                const filtered = p.order
                    .map(s => String(s || '').toLowerCase().trim())
                    .filter(s => VALID.includes(s));
                const deduped = [...new Set(filtered)];
                if (deduped.length) order = deduped;
            }
            if (typeof p.parallel === 'boolean') parallel = p.parallel;
            if (typeof p.rationale === 'string') rationale = p.rationale.slice(0, 200);
        }
        // Single-stage runs can't be parallel
        if (order.length < 2) parallel = false;
        return { order, parallel, rationale, skipped: VALID.filter(s => !order.includes(s)) };
    }

    async run(projectDesc, modelOverrides, clientKeys, customModels) {
        const models = this.resolveModels(modelOverrides);
        const state = { status: 'running', currentAgent: null, plan: null, outputs: {}, reviews: {}, models };
        // Per-run router: client keys override defaults; custom models attached as-is
        const router = this.buildRouter(clientKeys, customModels);

        // Fresh cancellation context for this run; the signal aborts provider calls.
        this.cancelled = false;
        this.abortController = new AbortController();
        router.signal = this.abortController.signal;
        const MAX_REVISIONS = this.maxRevisions;
        const ensureNotCancelled = () => {
            if (this.cancelled) {
                const e = new Error('Pipeline stopped by user.');
                e.stopped = true;
                throw e;
            }
        };
        // Turn a Supervisor verdict into actionable guidance for an auto-revision pass.
        const guidanceFrom = (review) => {
            const issues = Array.isArray(review.issues) && review.issues.length
                ? `\nSpecific issues to address:\n- ${review.issues.join('\n- ')}`
                : '';
            return `A reviewer rejected your previous attempt. Produce a corrected, complete version that fixes the problems below.\nReviewer feedback: ${review.feedback || 'Improve correctness and completeness.'}${issues}`;
        };

        const log = (msg, type = 'agent') => {
            console.log(`[${new Date().toISOString()}] ${msg}`);
            this.broadcast({ type: 'log', msg, logType: type });
        };
        const setAgent = (name, status) => {
            state.currentAgent = name;
            this.broadcast({ type: 'agent_status', agent: name, status });
        };
        const setProgress = (name, pct) => {
            this.broadcast({ type: 'progress', agent: name, percent: pct });
        };

        // Build agents with chosen models
        const planner = new PlannerAgent(router, models.planner);
        const designer = new DesignerAgent(router, models.designer);
        const coder = new CoderAgent(router, models.coder);
        const devops = new DevOpsAgent(router, models.devops);
        const supervisor = new SupervisorAgent(router, models.supervisor);

        try {
            log(`🚀 Pipeline started — Planner=${router.label(models.planner)}, Designer=${router.label(models.designer)}, Coder=${router.label(models.coder)}, DevOps=${router.label(models.devops)}, Supervisor=${router.label(models.supervisor)}`, 'supervisor');
            setAgent('supervisor', 'active');
            log('🧠 Supervisor: Initializing pipeline...', 'supervisor');

            // === STAGE 1: PLANNER (auto-revise, then halt if still rejected) ===
            ensureNotCancelled();
            setAgent('planner', 'active');
            setProgress('planner', 10);
            let plan = await planner.execute(projectDesc, msg => log(`📋 ${msg}`));
            state.plan = plan;
            setProgress('planner', 100);

            let planReview = await supervisor.validate('Planner', plan, plan, log);
            for (let rev = 1; !planReview.approved && rev <= MAX_REVISIONS; rev++) {
                ensureNotCancelled();
                log(`🔧 Supervisor: auto-revising Planner (attempt ${rev}/${MAX_REVISIONS})...`, 'supervisor');
                setAgent('planner', 'active');
                setProgress('planner', 10);
                plan = await planner.execute(projectDesc, msg => log(`📋 ${msg}`), guidanceFrom(planReview));
                state.plan = plan;
                setProgress('planner', 100);
                planReview = await supervisor.validate('Planner', plan, plan, log);
            }
            state.reviews.planner = planReview;
            setAgent('planner', planReview.approved ? 'done' : 'error');
            if (!planReview.approved) {
                const e = new Error(`Planner output rejected after ${MAX_REVISIONS} revision attempt(s): ${planReview.feedback || 'quality not met'}`);
                e.stage = 'planner';
                throw e; // Halt — do not start the next stage on an incomplete plan
            }

            // === RESOLVE PLAN-DRIVEN PIPELINE ===
            const pipeline = Orchestrator.resolvePipeline(plan);
            state.pipeline = pipeline;
            const orderLog = pipeline.parallel
                ? `${pipeline.order.join(' ∥ ')}`
                : pipeline.order.join(' → ');
            log(`🧠 Supervisor: Pipeline → planner → ${orderLog} → devops`, 'supervisor');
            if (pipeline.rationale) log(`🧠 Supervisor: Rationale — ${pipeline.rationale}`, 'supervisor');
            if (pipeline.skipped.length) log(`🧠 Supervisor: Skipping stage(s): ${pipeline.skipped.join(', ')} (not needed for this project)`, 'supervisor');
            this.broadcast({ type: 'pipeline_order', order: pipeline.order, parallel: pipeline.parallel, skipped: pipeline.skipped, rationale: pipeline.rationale });
            this.broadcast({ type: 'arrow', index: 0, status: 'done' });

            // Mark skipped stages explicitly so the UI shows them as such
            for (const skip of pipeline.skipped) {
                this.broadcast({ type: 'agent_status', agent: skip, status: 'skipped' });
            }

            // === EXECUTE PLANNED STAGES (sequential or parallel) ===
            const stageMap = { designer, coder };
            const stageIcons = { designer: '🎨', coder: '⚙️' };
            const stageNames = { designer: 'Designer', coder: 'Coder' };

            const runStage = async (stage) => {
                try {
                    const agent = stageMap[stage];
                    let pct = 10;
                    const onStageLog = msg => {
                        log(`${stageIcons[stage]} ${msg}`);
                        pct = Math.min(90, pct + 12);
                        setProgress(stage, pct);
                    };
                    // One execution attempt (optionally with revision guidance).
                    const exec = (guidance) => {
                        setAgent(stage, 'active');
                        pct = 10;
                        setProgress(stage, pct);
                        return stage === 'coder'
                            ? agent.execute(plan, state.outputs.designer, onStageLog, guidance)
                            : agent.execute(plan, onStageLog, guidance);
                    };

                    ensureNotCancelled();
                    let out = await exec();
                    state.outputs[stage] = out;
                    setProgress(stage, 100);
                    let review = await supervisor.validate(stageNames[stage], out, plan, log);

                    for (let rev = 1; !review.approved && rev <= MAX_REVISIONS; rev++) {
                        ensureNotCancelled();
                        log(`🔧 Supervisor: auto-revising ${stageNames[stage]} (attempt ${rev}/${MAX_REVISIONS})...`, 'supervisor');
                        out = await exec(guidanceFrom(review));
                        state.outputs[stage] = out;
                        setProgress(stage, 100);
                        review = await supervisor.validate(stageNames[stage], out, plan, log);
                    }
                    state.reviews[stage] = review;
                    setAgent(stage, review.approved ? 'done' : 'error');
                    if (!review.approved) {
                        const e = new Error(`${stageNames[stage]} output rejected after ${MAX_REVISIONS} revision attempt(s): ${review.feedback || 'quality not met'}`);
                        e.stage = stage;
                        throw e; // Halt the pipeline — don't proceed past a failed stage
                    }
                } catch (err) {
                    // Attribute the failure to THIS stage (important in parallel mode)
                    setAgent(stage, 'error');
                    throw err;
                }
            };

            if (pipeline.parallel && pipeline.order.length > 1) {
                log(`🧠 Supervisor: Running ${pipeline.order.join(' & ')} in PARALLEL`, 'supervisor');
                await Promise.all(pipeline.order.map(runStage));
            } else {
                for (const stage of pipeline.order) await runStage(stage);
            }

            // Animate the in-between arrows as complete (informational only — UI may hide some on skip)
            this.broadcast({ type: 'arrow', index: 1, status: 'done' });
            this.broadcast({ type: 'arrow', index: 2, status: 'done' });

            // === STAGE 4: DEVOPS (always last) ===
            ensureNotCancelled();
            let devopsPct = 10;
            const devopsLog = msg => {
                log(`🚀 ${msg}`);
                devopsPct = Math.min(90, devopsPct + 10);
                setProgress('devops', devopsPct);
            };
            const runDevops = (guidance) => {
                setAgent('devops', 'active');
                devopsPct = 10;
                setProgress('devops', devopsPct);
                return devops.execute(plan, state.outputs.designer, state.outputs.coder, devopsLog, guidance);
            };
            let devopsOutput = await runDevops();
            state.outputs.devops = devopsOutput;
            setProgress('devops', 100);

            let devopsReview = await supervisor.validate('DevOps', devopsOutput, plan, log);
            for (let rev = 1; !devopsReview.approved && rev <= MAX_REVISIONS; rev++) {
                ensureNotCancelled();
                log(`🔧 Supervisor: auto-revising DevOps (attempt ${rev}/${MAX_REVISIONS})...`, 'supervisor');
                devopsOutput = await runDevops(guidanceFrom(devopsReview));
                state.outputs.devops = devopsOutput;
                setProgress('devops', 100);
                devopsReview = await supervisor.validate('DevOps', devopsOutput, plan, log);
            }
            state.reviews.devops = devopsReview;
            setAgent('devops', devopsReview.approved ? 'done' : 'error');
            if (!devopsReview.approved) {
                const e = new Error(`DevOps output rejected after ${MAX_REVISIONS} revision attempt(s): ${devopsReview.feedback || 'quality not met'}`);
                e.stage = 'devops';
                throw e;
            }

            // === FINAL ===
            log('💾 Saving all generated files...', 'supervisor');
            const safeName = Orchestrator.sanitizeProjectName(plan.projectName);
            const projectDir = path.join(this.outputDir, safeName);
            try {
                await this.saveFiles(projectDir, state.outputs, plan, state.reviews);
            } catch (e) {
                log(`⚠️ File save failed: ${e.message}`, 'error');
                this.broadcast({ type: 'log', msg: `⚠️ File save failed: ${e.message}`, logType: 'error' });
            }

            const finalReport = await supervisor.finalReview(plan, state.outputs, log);
            setAgent('supervisor', 'done');

            state.status = 'complete';
            state.projectDir = projectDir;
            state.finalReport = finalReport;
            this.broadcast({ type: 'complete', state });
            log(`✨ Pipeline complete! Project saved to: ${projectDir}`, 'success');
            return state;
        } catch (error) {
            const wasStopped = error?.stopped || this.cancelled;
            if (wasStopped) {
                state.status = 'stopped';
                state.error = 'Pipeline stopped by user.';
                log('🛑 Pipeline stopped by user.', 'info');
                if (state.currentAgent) setAgent(state.currentAgent, 'idle');
                this.broadcast({ type: 'stopped', error: state.error });
                return state; // A user stop is intentional, not an error to rethrow
            }
            state.status = 'failed';
            const friendly = this.formatError(error, router);
            state.error = friendly;
            log(`❌ Pipeline failed: ${friendly}`, 'error');
            if (state.currentAgent) setAgent(state.currentAgent, 'error');
            this.broadcast({ type: 'error', error: friendly, provider: error.provider, status: error.status });
            throw error;
        } finally {
            this.abortController = null;
        }
    }

    formatError(err, router) {
        const r = router || this.router;
        const m = err?.message || String(err);
        // Quota / rate limit hint
        if (err?.status === 429 || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(m)) {
            const retry = m.match(/retry in (\d+(?:\.\d+)?)s/i);
            const tail = retry ? ` (retry in ~${Math.round(parseFloat(retry[1]))}s)` : '';
            return `${err.provider ? `[${r.label(err.provider)}] ` : ''}Quota / rate-limit exceeded${tail}. Try a different model or wait.`;
        }
        return m.length > 220 ? m.slice(0, 220) + '…' : m;
    }

    async saveFiles(projectDir, outputs, plan, reviews) {
        fs.mkdirSync(projectDir, { recursive: true });
        const baseDir = path.resolve(projectDir);
        fs.writeFileSync(path.join(baseDir, 'plan.json'), JSON.stringify(plan, null, 2));
        if (reviews && Object.keys(reviews).length) {
            fs.writeFileSync(path.join(baseDir, 'reviews.json'), JSON.stringify(reviews, null, 2));
        }
        let skipped = 0;
        for (const [, output] of Object.entries(outputs)) {
            if (!output?.files) continue;
            for (const file of output.files) {
                if (!file?.path || typeof file.content !== 'string') { skipped++; continue; }
                const resolved = path.resolve(baseDir, file.path);
                // Refuse anything that escapes the project dir
                if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
                    console.warn(`Skipped unsafe path: ${file.path}`);
                    skipped++;
                    continue;
                }
                try {
                    fs.mkdirSync(path.dirname(resolved), { recursive: true });
                    fs.writeFileSync(resolved, file.content);
                } catch (e) {
                    console.warn(`Failed to write ${file.path}: ${e.message}`);
                    skipped++;
                }
            }
        }
        if (skipped > 0) console.warn(`saveFiles: skipped ${skipped} file(s)`);
    }

    static sanitizeProjectName(name) {
        const cleaned = String(name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        // Reject pure-dot names like "." or ".." after sanitization
        return /^[._-]+$/.test(cleaned) ? 'project' : (cleaned || 'project');
    }
}

module.exports = Orchestrator;
