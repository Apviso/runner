import { lookup } from "node:dns/promises";
import { accessSync, constants } from "node:fs";
import { isIP } from "node:net";
import { runCommand } from "./process.js";
import { runnerFetch } from "./fetch.js";
import { hasAnthropicCredential, hasBedrockCredentials, hasClaudeCodeToken, hasCloudflareAiGatewayCredentials, hasGitHubCopilotToken, hasOpenAIApiKey, hasOpenAICodexAuthFile, missingCloudflareAiGatewayEnv, OPENAI_CODEX_LOGIN_REMEDIATION, } from "./providers.js";
export const DOCKER_INSTALL_URL = "https://docs.docker.com/engine/install/";
const DOCKER_REMEDIATION = `Install Docker Engine or Docker Desktop (${DOCKER_INSTALL_URL}), or make Docker socket access available to the runner.`;
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
function isBlockedIpv4(address) {
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return true;
    const [a, b] = parts;
    return a === 0 ||
        a === 10 ||
        a === 127 ||
        a === 169 && b === 254 ||
        a === 172 && b >= 16 && b <= 31 ||
        a === 192 && b === 168 ||
        a === 100 && b >= 64 && b <= 127 ||
        a === 198 && (b === 18 || b === 19) ||
        a >= 224;
}
function isBlockedIp(address) {
    const mappedIpv4 = address.match(/^::ffff:(?<ipv4>\d+\.\d+\.\d+\.\d+)$/i)?.groups?.ipv4;
    if (mappedIpv4)
        return isBlockedIpv4(mappedIpv4);
    const kind = isIP(address);
    if (kind === 4)
        return isBlockedIpv4(address);
    if (kind !== 6)
        return true;
    const lower = address.toLowerCase();
    return lower === "::" ||
        lower === "::1" ||
        lower.startsWith("fc") ||
        lower.startsWith("fd") ||
        lower.startsWith("fe80:") ||
        lower.startsWith("ff");
}
function shouldBlockInternalProbe(visibility) {
    return visibility === "public" || visibility === "staging_preview";
}
function lookupHostname(hostname) {
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
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
    return credentialCheck(hasOpenAICodexAuthFile(), "OpenAI Codex auth file present", "OpenAI Codex auth file is missing", OPENAI_CODEX_LOGIN_REMEDIATION);
}
export async function runPreflight(config, job) {
    const checks = {};
    const docker = await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8_000 })
        .catch((err) => ({ code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
    checks.container_engine = check(docker.code === 0, docker.code === 0 ? `Docker ${docker.stdout.trim()}` : "Docker is unavailable", docker.code === 0 ? undefined : DOCKER_REMEDIATION);
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
        const hostname = lookupHostname(url.hostname);
        const literalAddress = isIP(hostname) ? hostname : undefined;
        const resolvedAddresses = literalAddress
            ? [literalAddress]
            : await lookup(hostname, { all: true }).then((results) => results.map((result) => result.address), (err) => {
                checks.dns = check(false, `Could not resolve ${hostname}: ${err instanceof Error ? err.message : String(err)}`, "Check private DNS/VPN/proxy settings on the runner host.");
                return [];
            });
        const dns = resolvedAddresses.length > 0
            ? check(true, literalAddress ? `Using literal target address ${literalAddress}` : `Resolved ${hostname} to ${resolvedAddresses.join(", ")}`)
            : checks.dns ?? check(false, `Could not resolve ${hostname}`, "Check private DNS/VPN/proxy settings on the runner host.");
        checks.dns = dns;
        const blockedAddresses = shouldBlockInternalProbe(job.target.visibility)
            ? resolvedAddresses.filter(isBlockedIp)
            : [];
        checks.target_scope = check(blockedAddresses.length === 0, blockedAddresses.length === 0
            ? "Runner-side target scope check passed"
            : `Refusing ${job.target.visibility} target probe to internal address ${blockedAddresses.join(", ")}`, blockedAddresses.length === 0 ? undefined : "Use private/internal or localhost visibility for runner-local addresses.");
        const reachable = blockedAddresses.length > 0
            ? check(false, "HTTP probe skipped because target resolved to an internal address")
            : await runnerFetch(config, url, { method: "HEAD" }, { timeoutMs: 8_000 }).then((res) => check(res.status < 500, `HTTP probe returned ${res.status}`, res.status < 500 ? undefined : "Verify the target is reachable and not returning server errors from this runner."), (err) => check(false, `HTTP probe failed: ${err instanceof Error ? err.message : String(err)}`, "Verify the target is reachable from this runner and that proxy/custom CA settings are correct."));
        checks.reachability = reachable;
        const digestOk = /^sha256:[a-fA-F0-9]{64}$/.test(job.image.digest);
        checks.image_digest = check(digestOk, digestOk ? "Image digest is pinned" : "Image digest is missing or invalid", digestOk ? undefined : "Runner refuses mutable image tags; configure APVISO_SCAN_IMAGE_DIGEST.");
        const cosign = config.requireImageSignature && !config.allowUnsignedDevImages
            ? await runCommand("cosign", ["version"], { timeoutMs: 8_000, maxBufferBytes: 64 * 1024 })
                .catch((err) => ({ code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }))
            : { code: 0, stdout: "", stderr: "" };
        const signatureOk = (!!job.image.signature && cosign.code === 0) || config.allowUnsignedDevImages || !config.requireImageSignature;
        checks.image_signature = check(signatureOk, signatureOk ? "Image signature policy satisfied" : !job.image.signature ? "Image signature missing" : "Cosign is unavailable", signatureOk ? undefined : !job.image.signature
            ? "Publish a signed scan image or set APVISO_ALLOW_UNSIGNED_DEV_IMAGES=true in development only."
            : "Install cosign and configure APVISO_COSIGN_* trust settings if you use a custom signer.");
    }
    const ok = Object.values(checks).every((entry) => entry.ok);
    return {
        ok,
        checks,
        ...(ok ? {} : { errorCode: "preflight_failed", errorMessage: "Runner preflight failed. See individual checks." }),
    };
}
