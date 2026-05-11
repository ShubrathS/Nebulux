class DevOpsAgent {
    constructor(router, model = 'claude') {
        this.router = router;
        this.model = model;
        this.name = 'DevOps';
    }

    async execute(plan, designOutput, coderOutput, onLog) {
        const results = { files: [], testResults: [] };
        const allFiles = [...(designOutput?.files || []), ...(coderOutput?.files || [])];
        const label = this.router.label(this.model);

        // Tests
        onLog(`🧪 ${label}: Writing test files...`);
        const backendFiles = allFiles.filter(f => f.path.startsWith('backend/'));
        if (backendFiles.length > 0) {
            const testCode = await this.call(
                'You are a QA engineer. Write comprehensive test cases.',
                `Write Jest test files for these backend files:\n\n${backendFiles.map(f => `--- ${f.path} ---\n${f.content.slice(0, 1500)}`).join('\n\n')}\n\nOutput ONLY raw JavaScript test code. No markdown.`
            );
            results.files.push({ path: 'tests/api.test.js', content: testCode });
        }

        // Bug analysis
        onLog(`🔍 ${label}: Analyzing code for bugs...`);
        for (const file of allFiles) {
            try {
                const fixed = await this.call(
                    'You are a code reviewer. Find bugs and fix them. Output ONLY the corrected code. No explanations.',
                    `Review this file for bugs, security issues, and improvements. Return the FIXED version:\n\n--- ${file.path} ---\n${file.content}`
                );
                file.content = fixed;
            } catch { /* skip */ }
        }
        onLog(`Fixed ${allFiles.length} files`);

        // Deployment config
        onLog(`📦 ${label}: Generating deployment config...`);
        const dockerCode = await this.call(
            'You are a DevOps engineer.',
            `Generate a Dockerfile and docker-compose.yml for a project with:\n- Frontend: static HTML/CSS/JS\n- Backend: Node.js Express on port 4000\n\nOutput EXACTLY in this format with no extra prose:\n===FILE: Dockerfile===\n<content>\n===FILE: docker-compose.yml===\n<content>`
        );
        const sections = [...dockerCode.matchAll(/===\s*FILE:\s*([^=\n]+?)\s*===\s*\n([\s\S]*?)(?=\n===\s*FILE:|$)/g)];
        if (sections.length) {
            for (const m of sections) {
                const name = m[1].trim().replace(/[^a-zA-Z0-9_.\-/]/g, '');
                const content = m[2].trim();
                if (name && content) results.files.push({ path: name, content });
            }
        } else {
            // Best-effort fallback: write the whole blob to one file
            onLog(`⚠️ ${label}: Could not parse Dockerfile sections — saving raw output as deploy.txt`);
            results.files.push({ path: 'deploy.txt', content: dockerCode });
        }

        // README
        onLog(`📄 ${label}: Generating README...`);
        const readme = await this.call(
            'You are a technical writer.',
            `Write a professional README.md for this project:\nName: ${plan.projectName}\nSummary: ${plan.summary}\nTech Stack: ${JSON.stringify(plan.techStack)}\nEndpoints: ${JSON.stringify(plan.apiEndpoints?.slice(0, 5))}\n\nInclude: setup instructions, API docs, project structure.`
        );
        results.files.push({ path: 'README.md', content: readme });

        onLog(`DevOps complete: ${results.files.length} files, code reviewed and fixed`);
        return results;
    }

    async call(system, prompt) {
        const text = await this.router.chat(this.model, { system, prompt, maxTokens: 6000 });
        return this.router.stripFences(text);
    }
}

module.exports = DevOpsAgent;
