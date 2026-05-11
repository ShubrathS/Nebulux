class CoderAgent {
    constructor(router, model = 'gemma') {
        this.router = router;
        this.model = model;
        this.name = 'Coder';
        this.fallbackWarned = false;
    }

    async execute(plan, designOutput, onLog) {
        const results = { files: [] };
        const label = this.router.label(this.model);
        this.onLog = onLog;

        onLog(`🔧 ${label}: Generating backend code...`);

        onLog(`${label}: Creating server entry point...`);
        const serverCode = await this.gen(`Generate a complete Node.js Express server file (server.js). Include:
- Express setup with CORS and JSON parsing
- These API endpoints: ${JSON.stringify(plan.apiEndpoints || [])}
- These data models: ${JSON.stringify(plan.dataModels || [])}
- Error handling middleware
- Port from env or 4000
Output ONLY the raw JavaScript code, no explanations.`);
        results.files.push({ path: 'backend/server.js', content: serverCode });

        const endpoints = plan.apiEndpoints || [];
        const groups = {};
        endpoints.forEach(ep => {
            const resource = ep.path.split('/')[2] || 'main';
            if (!groups[resource]) groups[resource] = [];
            groups[resource].push(ep);
        });

        for (const [resource, eps] of Object.entries(groups)) {
            onLog(`${label}: Creating ${resource} routes...`);
            const routeCode = await this.gen(`Generate an Express router module for "${resource}" with these endpoints: ${JSON.stringify(eps)}. Data models: ${JSON.stringify(plan.dataModels || [])}. Include input validation. Output ONLY raw JavaScript, no markdown.`);
            results.files.push({ path: `backend/routes/${resource}.js`, content: routeCode });
        }

        if (plan.dataModels?.length) {
            onLog(`${label}: Creating data models...`);
            const modelCode = await this.gen(`Generate JavaScript data models/schemas for: ${JSON.stringify(plan.dataModels)}. Use simple in-memory storage with CRUD operations. Export each model. Output ONLY raw JavaScript.`);
            results.files.push({ path: 'backend/models/index.js', content: modelCode });
        }

        // Review & polish pass with the SAME chosen model
        onLog(`🧪 ${label}: Reviewing and improving backend code...`);
        for (let i = 0; i < results.files.length; i++) {
            const file = results.files[i];
            onLog(`${label}: Reviewing ${file.path}...`);
            results.files[i].content = await this.review(file.content, file.path, plan);
        }

        results.files.push({
            path: 'backend/package.json',
            content: JSON.stringify({
                name: plan.projectName?.toLowerCase().replace(/\s+/g, '-') || 'backend',
                version: '1.0.0',
                main: 'server.js',
                scripts: { start: 'node server.js', dev: 'node --watch server.js' },
                dependencies: { express: '^4.21.0', cors: '^2.8.5' }
            }, null, 2)
        });

        onLog(`Coder complete: ${results.files.length} backend files generated`);
        return results;
    }

    async gen(prompt) {
        try {
            const text = await this.router.chat(this.model, { prompt, maxTokens: 4000 });
            return this.router.stripFences(text);
        } catch (e) {
            if (this.model === 'claude') throw e; // Don't fallback claude→claude
            if (!this.fallbackWarned) {
                this.fallbackWarned = true;
                const m = (this.onLog || (() => {}));
                m(`⚠️ ${this.router.label(this.model)} failed (${e.message}). Falling back to Claude for this stage. Check model availability before next run.`);
            }
            const text = await this.router.chat('claude', {
                system: 'You are an expert backend developer. Output ONLY raw code, no markdown fences or explanations.',
                prompt,
                maxTokens: 4000
            });
            return this.router.stripFences(text);
        }
    }

    async review(code, filePath, plan) {
        try {
            const text = await this.router.chat(this.model, {
                system: 'You are an expert backend developer. Review and improve the given code. Fix bugs, add error handling, improve structure. Output ONLY the improved raw code, no explanations or markdown fences.',
                prompt: `Review and improve this ${filePath} file for project "${plan.projectName || 'Project'}":\n\n${code}`,
                maxTokens: 6000
            });
            return this.router.stripFences(text);
        } catch {
            return code; // keep original if review fails
        }
    }
}

module.exports = CoderAgent;
