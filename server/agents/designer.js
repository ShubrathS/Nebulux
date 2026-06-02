class DesignerAgent {
    constructor(router, model = 'kimi') {
        this.router = router;
        this.model = model;
        this.name = 'Designer';
    }

    async execute(plan, onLog, guidance) {
        const results = { files: [] };
        const label = this.router.label(this.model);
        // Prepended to every prompt during a Supervisor-requested revision pass.
        this.guidance = guidance ? `REVISION REQUEST — fix this and output a complete, corrected result:\n${guidance}\n\n` : '';

        // Step 1: Design concept
        onLog(`🎨 ${label}: ${guidance ? 'Revising design per Supervisor feedback...' : 'Generating UI/UX design concepts...'}`);
        let designConcept = '';
        try {
            designConcept = await this.router.chat(this.model, {
                system: 'You are an expert UI/UX designer. Create detailed design specifications including layout, color palette, typography, component hierarchy, and user flow. Be specific about CSS values, spacing, and responsive breakpoints.',
                prompt: `${this.guidance}Design the UI/UX for this project:\n\nProject: ${plan.projectName}\nSummary: ${plan.summary}\nPages: ${JSON.stringify(plan.designRequirements?.pages)}\nComponents: ${JSON.stringify(plan.designRequirements?.components)}\nStyle: ${plan.designRequirements?.style || 'modern'}`,
                maxTokens: 4000
            });
            onLog(`${label}: Design concepts ready`);
        } catch (e) {
            onLog(`${label} design step failed: ${e.message} — proceeding without spec`);
        }

        // Step 2: Frontend code
        const rawPages = Array.isArray(plan.designRequirements?.pages)
            ? plan.designRequirements.pages.filter(p => typeof p === 'string' && p.trim())
            : [];
        const pages = rawPages.length ? rawPages : ['index'];
        for (const page of pages) {
            onLog(`${label}: Building ${page} page...`);
            const html = await this.generate(plan, page, designConcept, 'html');
            // Sanitize the page name into a safe, flat filename
            const safe = String(page).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'page';
            results.files.push({ path: `frontend/${safe}.html`, content: html });
        }

        onLog(`${label}: Generating stylesheet...`);
        const css = await this.generate(plan, 'main', designConcept, 'css');
        results.files.push({ path: 'frontend/style.css', content: css });

        onLog(`${label}: Generating frontend JavaScript...`);
        const js = await this.generate(plan, 'main', designConcept, 'js');
        results.files.push({ path: 'frontend/script.js', content: js });

        onLog(`Designer complete: ${results.files.length} frontend files generated`);
        return results;
    }

    async generate(plan, pageName, designConcept, fileType) {
        const prompts = {
            html: `Generate a complete, production-ready HTML file for the "${pageName}" page. Include semantic HTML5, proper meta tags, link to style.css and script.js. Design: ${plan.designRequirements?.style || 'modern dark theme'}. Components needed: ${JSON.stringify(plan.designRequirements?.components)}. ${designConcept ? 'Follow this design spec: ' + designConcept.slice(0, 2000) : ''}. Output ONLY the raw HTML code, no markdown.`,
            css: `Generate a complete, production-ready CSS stylesheet for this project. Style: ${plan.designRequirements?.colorScheme || 'dark theme with purple accents'}. ${designConcept ? 'Follow this design spec: ' + designConcept.slice(0, 2000) : ''}. Include responsive design, animations, modern aesthetics. Output ONLY the raw CSS code, no markdown.`,
            js: `Generate frontend JavaScript for this project. Handle DOM interactions, form submissions, API calls to the backend at /api/. Pages: ${JSON.stringify(plan.designRequirements?.pages)}. API endpoints: ${JSON.stringify(plan.apiEndpoints?.slice(0, 5))}. Output ONLY the raw JS code, no markdown.`
        };
        const text = await this.router.chat(this.model, { prompt: (this.guidance || '') + prompts[fileType], maxTokens: 4000 });
        return this.router.stripFences(text);
    }
}

module.exports = DesignerAgent;
