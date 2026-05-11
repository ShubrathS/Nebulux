class PlannerAgent {
    constructor(router, model = 'claude') {
        this.router = router;
        this.model = model;
        this.name = 'Planner';
    }

    async execute(projectDesc, onLog) {
        onLog(`Analyzing project requirements (using ${this.router.label(this.model)})...`);

        const text = await this.router.chat(this.model, {
            system: `You are an expert software architect and project planner. Your job is to create a comprehensive implementation plan for a software project. You must output ONLY valid JSON with this exact structure:
{
  "projectName": "string",
  "summary": "string",
  "techStack": { "frontend": [], "backend": [], "database": [], "tools": [] },
  "fileStructure": ["path/to/file1", "path/to/file2"],
  "milestones": [{ "name": "string", "tasks": ["task1", "task2"] }],
  "apiEndpoints": [{ "method": "GET/POST/etc", "path": "/api/...", "description": "string" }],
  "dataModels": [{ "name": "string", "fields": [{ "name": "string", "type": "string" }] }],
  "designRequirements": { "pages": ["page1"], "components": ["comp1"], "colorScheme": "string", "style": "string" },
  "testingStrategy": { "unit": [], "integration": [], "e2e": [] },
  "pipeline": {
    "order": ["coder", "designer"],
    "parallel": false,
    "rationale": "string explaining why this order"
  }
}

PIPELINE FIELD RULES — read carefully, this dictates execution:
- "order" is a subset of ["designer", "coder"]. DevOps/Tester always runs LAST and must NOT appear here.
- Include only the stages this project actually needs. Examples:
    * Backend-only API or CLI tool          → ["coder"]
    * Static landing page / pure frontend   → ["designer"]
    * Full-stack app, API-driven            → ["coder", "designer"]   (backend first defines the API contract)
    * Full-stack app, UX-driven prototype   → ["designer", "coder"]   (frontend first drives the API design)
- "parallel": true only when both stages are independent and order doesn't matter — this halves wait time.
  Set parallel: false if one stage's output realistically informs the other.
- "rationale" is a short sentence explaining the choice. Be specific to THIS project.`,
            prompt: `Create a detailed implementation plan for this project:\n\n${projectDesc}`,
            maxTokens: 8000
        });

        onLog('Implementation plan generated');

        let plan;
        try {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            plan = JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch {
            plan = { raw: text, projectName: 'Project', summary: text.slice(0, 200) };
        }

        onLog(`Plan complete: ${plan.fileStructure?.length || 0} files, ${plan.apiEndpoints?.length || 0} endpoints`);
        return plan;
    }
}

module.exports = PlannerAgent;
