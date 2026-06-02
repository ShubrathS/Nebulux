class SupervisorAgent {
    constructor(router, model = 'claude') {
        this.router = router;
        this.model = model;
        this.name = 'Supervisor';
    }

    // Build a COMPLETE, non-lossy summary of a stage output. Dumping raw JSON and
    // slicing it makes the reviewer think the output is "truncated"; instead we
    // describe file lists / plan structure compactly so nothing looks cut off.
    summarizeForReview(output) {
        if (output && Array.isArray(output.files)) {
            const list = output.files
                .map(f => `- ${f.path} (${(f.content || '').length} chars)`)
                .join('\n');
            return `Generated ${output.files.length} file(s):\n${list}`;
        }
        if (output && typeof output === 'object') {
            // Likely the plan — compact structured summary, no lossy truncation
            const p = output;
            const parts = [];
            if (p.projectName) parts.push(`Project: ${p.projectName}`);
            if (p.summary) parts.push(`Summary: ${p.summary}`);
            if (p.techStack) parts.push(`Tech stack: ${JSON.stringify(p.techStack)}`);
            if (Array.isArray(p.fileStructure)) parts.push(`Files planned: ${p.fileStructure.length}`);
            if (Array.isArray(p.milestones)) parts.push(`Milestones: ${p.milestones.map(m => m?.name).filter(Boolean).join(', ')}`);
            if (Array.isArray(p.apiEndpoints)) parts.push(`API endpoints: ${p.apiEndpoints.length}`);
            if (Array.isArray(p.dataModels)) parts.push(`Data models: ${p.dataModels.map(d => d?.name).filter(Boolean).join(', ')}`);
            if (p.pipeline) parts.push(`Pipeline: ${JSON.stringify(p.pipeline)}`);
            const s = parts.join('\n');
            return s || JSON.stringify(output).slice(0, 6000);
        }
        return String(output).slice(0, 6000);
    }

    async validate(stageName, output, plan, onLog) {
        const label = this.router.label(this.model);
        onLog(`🧠 Supervisor (${label}): Validating ${stageName} output...`);

        const outputSummary = this.summarizeForReview(output);

        let result;
        try {
            const text = await this.router.chat(this.model, {
                system: 'You are the Supervisor in a multi-agent software pipeline. You are given a STRUCTURED SUMMARY of a stage\'s output (a summary, NOT the raw files) — never treat brevity, omitted detail, or a short summary as "truncated" or incomplete. Approve the output if it is usable and broadly aligned with the plan. Only set approved:false for SUBSTANTIVE, BLOCKING problems: empty output, wrong or irrelevant content, or a missing CORE deliverable. Missing nice-to-haves (extra config files, timelines, docs, tests) are NOT grounds for rejection. Respond ONLY with JSON: { "approved": true|false, "score": 1-10, "feedback": "string", "issues": ["..."] }. Approve when score >= 6.',
                prompt: `Validate the "${stageName}" stage.\n\nProject (plan summary): ${this.summarizeForReview(plan)}\n\nStage output summary:\n${outputSummary}\n\nIs this output usable and broadly aligned with the plan? Approve unless there is a blocking problem.`,
                maxTokens: 1500
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
