import { RunnerApi } from "./api.js";
import { runPreflight } from "./preflight.js";
function check(ok, message, remediation) {
    return { ok, message, ...(remediation ? { remediation } : {}) };
}
export async function runDoctor(config) {
    const result = await runPreflight(config);
    if (config.apiKey) {
        try {
            const readiness = await new RunnerApi(config).runnerReadiness();
            result.checks.cloud_api = check(true, `Connected to ${config.apiUrl}`);
            result.checks.license = check(readiness.visibilityOk, readiness.visibilityOk ? "Self-hosted license allows public runner scans" : readiness.reason ?? "License is not ready", readiness.visibilityOk ? undefined : "Check your APVISO self-hosted plan and target visibility.");
            result.checks.runner_readiness = check(readiness.runnerOk, readiness.runnerOk ? "At least one runner is online or degraded" : readiness.reason ?? "No healthy runner is online", readiness.runnerOk ? undefined : "Start this runner with `apviso run` after onboarding.");
        }
        catch (err) {
            result.checks.cloud_api = check(false, `Cloud API check failed: ${err instanceof Error ? err.message : String(err)}`, "Verify APVISO_API_URL and APVISO_API_KEY, then retry.");
        }
    }
    const ok = Object.values(result.checks).every((entry) => entry.ok);
    return {
        ...result,
        ok,
        ...(ok ? { errorCode: undefined, errorMessage: undefined } : {
            errorCode: "preflight_failed",
            errorMessage: "Runner doctor checks failed. See individual checks.",
        }),
    };
}
export function formatDoctor(result) {
    const lines = [
        result.ok ? "APVISO runner checks passed" : "APVISO runner checks need attention",
        "",
    ];
    for (const [name, entry] of Object.entries(result.checks)) {
        lines.push(`${entry.ok ? "[ok]" : "[fix]"} ${name.replaceAll("_", " ")}`);
        lines.push(`  ${entry.message}`);
        if (!entry.ok && entry.remediation)
            lines.push(`  Next: ${entry.remediation}`);
    }
    return lines.join("\n");
}
