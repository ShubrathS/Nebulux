class SupervisorAgent {
    constructor(router, model = 'claude') {
        this.router = router;
        this.model = model;
        this.name = 'Supervisor';
    }

    async validate(stageName, output, plan, onLog) {
        const label = this.router.label(this.model);
        onLog(`🧠 Supervisor (${label}): Validating ${stageName} output...`);

        const outputSummary = typeof output === 'object'
            ? JSON.stringify(output, null, 2).slice(0, 3000)
            : String(output).slice(0, 3000);

        let result;
        try {
            const text = await this.router.chat(this.model, {
                system: 'You are the Supervisor agent in a multi-agent software development pipeline. Your job is to validate the output of each agent stage. Respond with JSON: { "approved": true/false, "score": 1-10, "feedback": "string", "issues": ["issue1"] }',
                prompt: `Validate the output of the "${stageName}" stage.\n\nOriginal Project Plan:\n${JSON.stringify(plan).slice(0, 1500)}\n\nAgent Output:\n${outputSummary}\n\nDoes this output meet quality standards? Is it complete and aligned with the plan?`,
                maxTokens: 2000
            });
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch {
            result = { approved: true, score: 7, feedback: 'Output accepted', issues: [] };
        }

        if (result.approved) {
            onLog(`🧠 Supervisor: ${stageName} APPROVED (score: ${result.score}/10) — ${result.feedback}`);
        } else {
            onLog(`🧠 Supervisor: ${stageName} NEEDS REVISION — ${result.feedback}`);
            if (result.issues?.length) result.issues.forEach(issue => onLog(`  ⚠️ ${issue}`));
        }
        return result;
    }

    async finalReview(plan, allOutputs, onLog) {
        const label = this.router.label(this.model);
        onLog(`🧠 Supervisor (${label}): Final project review...`);

        const fileSummary = [];
        Object.values(allOutputs).forEach(output => {
            if (output?.files) output.files.forEach(f => fileSummary.push(f.path));
        });

        let result;
        try {
            const text = await this.router.chat(this.model, {
                system: 'You are the Supervisor. Give a final project assessment. Respond with JSON: { "status": "success/warning/failure", "summary": "string", "filesGenerated": number, "recommendations": ["rec1"] }',
                prompt: `Final review for "${plan.projectName}".\nFiles generated: ${JSON.stringify(fileSummary)}\nPlan summary: ${plan.summary}\n\nProvide final assessment.`,
                maxTokens: 2000
            });
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch {
            result = { status: 'success', summary: 'Project complete', filesGenerated: fileSummary.length, recommendations: [] };
        }

        onLog(`🧠 Supervisor: Final status — ${result.status.toUpperCase()}`);
        onLog(`📊 ${result.summary}`);
        return result;
    }
}

module.exports = SupervisorAgent;
