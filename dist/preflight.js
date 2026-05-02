import { lookup } from "node:dns/promises";
import { accessSync, constants } from "node:fs";
import { runCommand } from "./process.js";
import { hasAnthropicCredential, hasBedrockCredentials, hasClaudeCodeToken, hasCloudflareAiGatewayCredentials, hasGitHubCopilotToken, hasOpenAIApiKey, hasOpenAICodexToken, missingCloudflareAiGatewayEnv, } from "./providers.js";
function check(ok, message, remediation) {
    return { ok, message, ...(remediation ? { remediation } : {}) };
}
function credentialCheck(ok, present, missing, remediation) {
    return check(ok, ok ? present : missing, ok ? undefined : remediation);
}
function readableFile(path) {
    try {
        accessSync(path, constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
export function providerPreflight(config) {
    if (config.modelProvider === "anthropic") {
        return credentialCheck(hasAnthropicCredential(config), "Anthropic credentials present", "Anthropic credentials are missing", "Set ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN on the runner host.");
    }
    if (config.modelProvider === "claude-code") {
        return credentialCheck(hasClaudeCodeToken(config), "Claude Code setup token present", "Claude Code setup token is missing", "Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN on the runner host.");
    }
    if (config.modelProvider === "bedrock") {
        return credentialCheck(hasBedrockCredentials(config), "Bedrock credentials present", "Bedrock credentials are missing", "Set AWS_BEARER_TOKEN_BEDROCK, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE/shared credentials, ECS credentials, or web identity on the runner host.");
    }
    if (config.modelProvider === "openai") {
        return credentialCheck(hasOpenAIApiKey(config), "OpenAI API key present", "OpenAI API key is missing", "Set OPENAI_API_KEY on the runner host.");
    }
    if (config.modelProvider === "github-copilot") {
        return credentialCheck(hasGitHubCopilotToken(config), "GitHub Copilot token present", "GitHub Copilot token is missing", "Set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN on the runner host.");
    }
    if (config.modelProvider === "cloudflare-ai-gateway") {
        const missing = missingCloudflareAiGatewayEnv(config);
        return credentialCheck(hasCloudflareAiGatewayCredentials(config), "Cloudflare AI Gateway credentials present", "Cloudflare AI Gateway credentials are missing", `Set ${missing.length > 0 ? missing.join(", ") : "CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_GATEWAY_ID"} on the runner host.`);
    }
    return credentialCheck(hasOpenAICodexToken(config), "OpenAI Codex token present", "OpenAI Codex token is missing", "Set OPENAI_CODEX_OAUTH_TOKEN or OPENAI_CODEX_AUTH_FILE on the runner host.");
}
export async function runPreflight(config, job) {
    const checks = {};
    const docker = await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8_000 })
        .catch((err) => ({ code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
    checks.container_engine = check(docker.code === 0, docker.code === 0 ? `Docker ${docker.stdout.trim()}` : "Docker is unavailable", docker.code === 0 ? undefined : "Install Docker or set runner container engine access.");
    const provider = providerPreflight(config);
    checks.provider = provider;
    if (config.embeddingProvider === "bedrock-cohere") {
        const ok = hasBedrockCredentials(config);
        checks.embedding_provider = check(ok, ok ? "Bedrock/Cohere embedding credentials present" : "Bedrock/Cohere embedding credentials are missing", ok ? undefined : "Use APVISO_EMBEDDING_PROVIDER=local or set Bedrock credentials.");
    }
    else {
        checks.embedding_provider = check(true, "Local deterministic embeddings enabled");
    }
    if (config.targetAuthConfigFile) {
        const ok = readableFile(config.targetAuthConfigFile);
        checks.target_auth_config = check(ok, ok ? "Runner-local target auth config file configured" : "Runner-local target auth config file is not readable", ok ? undefined : "Check APVISO_TARGET_AUTH_CONFIG_FILE points to a readable JSON file on the runner host.");
    }
    else {
        checks.target_auth_config = check(true, "No runner-local target auth config file configured");
    }
    if (job) {
        const url = new URL(job.target.scanUrl.startsWith("http") ? job.target.scanUrl : `https://${job.target.scanUrl}`);
        const dns = await lookup(url.hostname).then((result) => check(true, `Resolved ${url.hostname} to ${result.address}`), (err) => check(false, `Could not resolve ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`, "Check private DNS/VPN/proxy settings on the runner host."));
        checks.dns = dns;
        const reachable = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000) }).then((res) => check(res.status < 500, `HTTP probe returned ${res.status}`, res.status < 500 ? undefined : "Verify the target is reachable and not returning server errors from this runner."), (err) => check(false, `HTTP probe failed: ${err instanceof Error ? err.message : String(err)}`, "Verify the target is reachable from this runner and that proxy/custom CA settings are correct."));
        checks.reachability = reachable;
        const digestOk = /^sha256:[a-fA-F0-9]{64}$/.test(job.image.digest);
        checks.image_digest = check(digestOk, digestOk ? "Image digest is pinned" : "Image digest is missing or invalid", digestOk ? undefined : "Runner refuses mutable image tags; configure APVISO_SCAN_IMAGE_DIGEST.");
        const signatureOk = !!job.image.signature || config.allowUnsignedDevImages || !config.requireImageSignature;
        checks.image_signature = check(signatureOk, signatureOk ? "Image signature policy satisfied" : "Image signature missing", signatureOk ? undefined : "Publish a signed scan image or set APVISO_ALLOW_UNSIGNED_DEV_IMAGES=true in development only.");
    }
    const ok = Object.values(checks).every((entry) => entry.ok);
    return {
        ok,
        checks,
        ...(ok ? {} : { errorCode: "preflight_failed", errorMessage: "Runner preflight failed. See individual checks." }),
    };
}
