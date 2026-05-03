import { arch, platform } from "node:os";
import { configPath, loadConfig, RUNNER_VERSION, saveConfig, saveRunnerToken } from "./config.js";
import { RunnerApi } from "./api.js";
import { RunnerDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { hasAnthropicCredential, hasBedrockCredentials, hasClaudeCodeToken, hasCloudflareAiGatewayCredentials, hasGitHubCopilotToken, hasOpenAIApiKey, hasOpenAICodexAuthFile, missingCloudflareAiGatewayEnv, MODEL_PROVIDERS, OPENAI_CODEX_LOGIN_REMEDIATION, providerState, } from "./providers.js";
import { defaultTargetAuthPath, expandHome, readTargetAuthSummaries, upsertTargetAuthConfig, } from "./target-auth.js";
export const EMBEDDING_PROVIDERS = ["local", "bedrock-cohere"];
export const VISIBILITIES = ["public", "staging_preview", "private_internal", "localhost", "partner_client"];
export const AUTH_TYPES = ["none", "bearer", "basic", "cookie", "api_key", "custom_headers", "login"];
export function tokenNamespace(token) {
    return token.split("_", 1)[0] ?? "";
}
export function normalizeDomain(input) {
    const value = input.trim();
    if (!value)
        return "";
    try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
        return parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    }
    catch {
        let domain = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
        if (domain.startsWith("[")) {
            const end = domain.indexOf("]");
            if (end >= 0)
                domain = domain.slice(1, end);
        }
        else if ((domain.match(/:/g) ?? []).length === 1) {
            domain = domain.split(":")[0];
        }
        return domain.replace(/\.$/, "").toLowerCase();
    }
}
export function localRuntimeUrl(input, visibility) {
    const value = input.trim();
    if (!value)
        return value;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        return value;
    if (visibility === "localhost" || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(value)) {
        return `http://${value}`;
    }
    return value;
}
export function registrationBody(config, enrollmentToken, name) {
    return {
        enrollmentToken,
        name,
        version: RUNNER_VERSION,
        os: platform(),
        arch: arch(),
        containerEngine: "docker",
        configuredConcurrency: config.concurrency,
        providerState: providerState(config.modelProvider, config.embeddingProvider, config),
    };
}
export function mergeProviderEnv(current, updates) {
    const next = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(updates ?? {})) {
        if (value?.trim())
            next[key] = value.trim();
    }
    return Object.keys(next).length > 0 ? next : undefined;
}
function assertRunnerTiming(config) {
    if (!Number.isFinite(config.concurrency) || config.concurrency <= 0) {
        throw new Error("Concurrency must be a positive number.");
    }
    if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
        throw new Error("Poll interval must be a positive number.");
    }
    if (!Number.isFinite(config.heartbeatIntervalMs) || config.heartbeatIntervalMs <= 0) {
        throw new Error("Heartbeat interval must be a positive number.");
    }
}
export function safeRunnerConfig(config = loadConfig()) {
    const safeProviderEnv = Object.fromEntries(Object.entries(config.providerEnv ?? {}).map(([key, value]) => [key, { present: !!value }]));
    return {
        apiUrl: config.apiUrl,
        apiKey: { present: !!config.apiKey },
        token: { present: !!config.token },
        workspaceDir: config.workspaceDir,
        runnerName: config.runnerName,
        containerEngine: config.containerEngine,
        concurrency: config.concurrency,
        pollIntervalMs: config.pollIntervalMs,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        modelProvider: config.modelProvider,
        embeddingProvider: config.embeddingProvider,
        providerEnv: safeProviderEnv,
        providerState: providerState(config.modelProvider, config.embeddingProvider, config),
        networkMode: config.networkMode,
        proxy: config.proxy,
        customCaPath: config.customCaPath,
        targetAuthConfigFile: config.targetAuthConfigFile,
        requireImageSignature: config.requireImageSignature,
        allowUnsignedDevImages: config.allowUnsignedDevImages,
        configPath: configPath(),
    };
}
export function assertProviderConfiguration(config) {
    if (config.modelProvider === "anthropic" && !hasAnthropicCredential(config)) {
        throw new Error("ANTHROPIC_API_KEY is required for the anthropic model provider.");
    }
    if (config.modelProvider === "claude-code" && !hasClaudeCodeToken(config)) {
        throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for the claude-code model provider.");
    }
    if (config.modelProvider === "openai" && !hasOpenAIApiKey(config)) {
        throw new Error("OPENAI_API_KEY is required for the openai model provider.");
    }
    if (config.modelProvider === "openai-codex" && !hasOpenAICodexAuthFile()) {
        throw new Error(OPENAI_CODEX_LOGIN_REMEDIATION);
    }
    if (config.modelProvider === "github-copilot" && !hasGitHubCopilotToken(config)) {
        throw new Error("COPILOT_GITHUB_TOKEN is required for the github-copilot model provider.");
    }
    if (config.modelProvider === "cloudflare-ai-gateway" && !hasCloudflareAiGatewayCredentials(config)) {
        const missing = missingCloudflareAiGatewayEnv(config);
        throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required for the cloudflare-ai-gateway model provider.`);
    }
    if (config.modelProvider === "bedrock" && !hasBedrockCredentials(config)) {
        throw new Error("Bedrock credentials are required. Provide AWS_BEARER_TOKEN_BEDROCK or configure AWS credentials in the runner environment.");
    }
    if (config.embeddingProvider === "bedrock-cohere" && !hasBedrockCredentials(config)) {
        throw new Error("AWS_BEARER_TOKEN_BEDROCK or AWS credentials are required for bedrock-cohere embeddings.");
    }
}
export function providerCredentialNames(provider) {
    if (provider === "anthropic")
        return ["ANTHROPIC_API_KEY"];
    if (provider === "claude-code")
        return ["CLAUDE_CODE_OAUTH_TOKEN"];
    if (provider === "openai")
        return ["OPENAI_API_KEY"];
    if (provider === "openai-codex")
        return [];
    if (provider === "github-copilot")
        return ["COPILOT_GITHUB_TOKEN"];
    if (provider === "cloudflare-ai-gateway") {
        return ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"];
    }
    return [
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_PROFILE",
    ];
}
export function embeddingCredentialNames(provider) {
    return provider === "bedrock-cohere" ? ["AWS_BEARER_TOKEN_BEDROCK"] : [];
}
export async function registerRunner(input) {
    if (!input.token)
        throw new Error("Missing runner registration token.");
    const config = loadConfig();
    const name = input.name || config.runnerName;
    const namespace = tokenNamespace(input.token);
    if (namespace === "apvr") {
        saveRunnerToken(input.token, config.apiUrl, name);
        return { mode: "runner-token", config: loadConfig() };
    }
    if (namespace !== "apve") {
        throw new Error("Expected an enrollment token starting with apve_ or a runner token starting with apvr_.");
    }
    const result = await new RunnerApi(config).register(registrationBody(config, input.token, name));
    saveRunnerToken(result.token, config.apiUrl, name);
    return { mode: "enrollment-token", config: loadConfig(), runner: result.runner };
}
export async function onboardRunner(input) {
    if (!input.apiCredential) {
        throw new Error("APVISO API key, enrollment token, or runner token is required for onboarding.");
    }
    if (!Number.isFinite(input.concurrency) || input.concurrency <= 0) {
        throw new Error("Concurrency must be a positive number.");
    }
    const current = loadConfig();
    const apiCredentialNamespace = tokenNamespace(input.apiCredential);
    const userApiKey = apiCredentialNamespace === "apvr" || apiCredentialNamespace === "apve"
        ? undefined
        : input.apiCredential;
    const providedRunnerToken = apiCredentialNamespace === "apvr" ? input.apiCredential : undefined;
    const providedEnrollmentToken = apiCredentialNamespace === "apve" ? input.apiCredential : undefined;
    if (apiCredentialNamespace === "apvj") {
        throw new Error("Job-scoped tokens cannot onboard a runner. Use an apvk_ API key, apve_ enrollment token, or apvr_ runner token.");
    }
    const providerEnv = mergeProviderEnv(current.providerEnv, input.providerEnv);
    const configUpdate = {
        apiUrl: input.apiUrl,
        apiKey: userApiKey,
        runnerName: input.runnerName,
        modelProvider: input.modelProvider,
        embeddingProvider: input.embeddingProvider,
        providerEnv,
        concurrency: input.concurrency,
        ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: Number(input.pollIntervalMs) } : {}),
        ...(input.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: Number(input.heartbeatIntervalMs) } : {}),
        workspaceDir: expandHome(input.workspaceDir),
        networkMode: input.networkMode || undefined,
        proxy: input.proxy || undefined,
        customCaPath: input.customCaPath ? expandHome(input.customCaPath) : undefined,
        targetAuthConfigFile: input.targetAuthConfigFile ? expandHome(input.targetAuthConfigFile) : undefined,
        ...(input.requireImageSignature !== undefined ? { requireImageSignature: input.requireImageSignature } : {}),
        ...(input.allowUnsignedDevImages !== undefined ? { allowUnsignedDevImages: input.allowUnsignedDevImages } : {}),
    };
    if (providedRunnerToken)
        configUpdate.token = providedRunnerToken;
    const candidate = { ...current, ...configUpdate };
    assertRunnerTiming(candidate);
    assertProviderConfiguration(candidate);
    saveConfig(configUpdate);
    const config = loadConfig();
    const api = new RunnerApi(config);
    if (providedRunnerToken) {
        await new RunnerDaemon(config).heartbeat();
    }
    else {
        const enrollmentToken = providedEnrollmentToken || (await api.createEnrollmentToken(input.runnerName)).token;
        const registered = await api.register(registrationBody(config, enrollmentToken, input.runnerName));
        saveRunnerToken(registered.token, config.apiUrl, input.runnerName);
    }
    const doctor = await runDoctor(loadConfig());
    return {
        mode: providedRunnerToken ? "runner-token" : providedEnrollmentToken ? "enrollment-token" : "api-key",
        doctor,
        config: loadConfig(),
    };
}
export function saveRunnerConfig(input) {
    const current = loadConfig();
    const providerEnv = mergeProviderEnv(current.providerEnv, input.providerEnv);
    const update = {
        ...(input.apiUrl ? { apiUrl: input.apiUrl } : {}),
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        ...(input.runnerToken ? { token: input.runnerToken } : {}),
        ...(input.runnerName ? { runnerName: input.runnerName } : {}),
        ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
        ...(input.embeddingProvider ? { embeddingProvider: input.embeddingProvider } : {}),
        ...(providerEnv ? { providerEnv } : {}),
        ...(input.concurrency !== undefined ? { concurrency: Number(input.concurrency) } : {}),
        ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: Number(input.pollIntervalMs) } : {}),
        ...(input.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: Number(input.heartbeatIntervalMs) } : {}),
        ...(input.workspaceDir ? { workspaceDir: expandHome(input.workspaceDir) } : {}),
        ...(input.networkMode !== undefined ? { networkMode: input.networkMode || undefined } : {}),
        ...(input.proxy !== undefined ? { proxy: input.proxy || undefined } : {}),
        ...(input.customCaPath !== undefined ? { customCaPath: input.customCaPath ? expandHome(input.customCaPath) : undefined } : {}),
        ...(input.targetAuthConfigFile !== undefined ? {
            targetAuthConfigFile: input.targetAuthConfigFile ? expandHome(input.targetAuthConfigFile) : undefined,
        } : {}),
        ...(input.requireImageSignature !== undefined ? { requireImageSignature: input.requireImageSignature } : {}),
        ...(input.allowUnsignedDevImages !== undefined ? { allowUnsignedDevImages: input.allowUnsignedDevImages } : {}),
    };
    const candidate = { ...current, ...update };
    assertRunnerTiming(candidate);
    if (input.modelProvider || input.embeddingProvider || input.providerEnv)
        assertProviderConfiguration(candidate);
    saveConfig(update);
    return loadConfig();
}
export async function createTarget(input) {
    const config = loadConfig();
    if (!config.apiKey)
        throw new Error("APVISO_API_KEY is required. Run `apviso onboard` first.");
    const displayUrl = input.target.trim();
    const scanUrl = localRuntimeUrl(input.scanUrl || displayUrl, input.visibility);
    const domain = normalizeDomain(displayUrl);
    if (!domain)
        throw new Error("Target display URL or domain is required.");
    const result = await new RunnerApi(config).createTarget({
        domain,
        displayUrl,
        scanUrl,
        visibility: input.visibility,
        partnerClientId: input.partnerClientId,
    });
    let authFile;
    if (input.auth) {
        authFile = input.targetAuthFile || config.targetAuthConfigFile || defaultTargetAuthPath();
        upsertTargetAuthConfig(authFile, result.target, input.auth, { mode: input.authMode ?? "append" });
        if (!config.targetAuthConfigFile)
            saveConfig({ targetAuthConfigFile: expandHome(authFile) });
    }
    return { target: result.target, authFile: authFile ? expandHome(authFile) : undefined };
}
export async function listPlatformTargets() {
    const config = loadConfig();
    if (!config.apiKey && !config.token) {
        throw new Error("APVISO_API_KEY or APVISO_RUNNER_TOKEN is required. Run `apviso onboard` first.");
    }
    const api = new RunnerApi(config);
    const limit = 100;
    const targets = [];
    let total = 0;
    let page = 1;
    while (page <= 100) {
        const result = await api.listTargets(page, limit);
        targets.push(...result.targets);
        total = result.total ?? targets.length;
        if (result.totalPages !== undefined ? page >= result.totalPages : result.targets.length < limit)
            break;
        page += 1;
    }
    const targetAuthFile = expandHome(config.targetAuthConfigFile || defaultTargetAuthPath());
    let targetAuthError;
    let authSummaries = {};
    try {
        authSummaries = readTargetAuthSummaries(targetAuthFile);
    }
    catch (err) {
        targetAuthError = err instanceof Error ? err.message : String(err);
    }
    return {
        targets: targets.map((target) => ({
            ...target,
            targetAuth: authSummaries[target.id] ?? { configured: false, count: 0, types: [] },
        })),
        total,
        targetAuthFile,
        ...(targetAuthError ? { targetAuthError } : {}),
    };
}
export async function savePlatformTargetAuth(input) {
    const config = loadConfig();
    if (!config.apiKey && !config.token) {
        throw new Error("APVISO_API_KEY or APVISO_RUNNER_TOKEN is required. Run `apviso onboard` first.");
    }
    const { target } = await new RunnerApi(config).getTarget(input.targetId);
    const authFile = input.targetAuthFile || config.targetAuthConfigFile || defaultTargetAuthPath();
    upsertTargetAuthConfig(authFile, target, input.auth, { mode: input.authMode ?? "append" });
    if (!config.targetAuthConfigFile)
        saveConfig({ targetAuthConfigFile: expandHome(authFile) });
    return { target, authFile: expandHome(authFile) };
}
export function addTargetAuth(input) {
    const config = loadConfig();
    const targetId = input.targetId || input.target;
    const domain = input.domain || normalizeDomain(input.target);
    const displayUrl = input.displayUrl || (input.target.includes("://") ? input.target : domain || input.target);
    const target = {
        id: targetId,
        domain: domain || normalizeDomain(displayUrl) || targetId,
        displayUrl,
        scanUrl: input.scanUrl || undefined,
    };
    const authFile = input.targetAuthFile || config.targetAuthConfigFile || defaultTargetAuthPath();
    upsertTargetAuthConfig(authFile, target, input.auth, { mode: input.authMode ?? "append" });
    if (!config.targetAuthConfigFile)
        saveConfig({ targetAuthConfigFile: expandHome(authFile) });
    return { target, authFile: expandHome(authFile) };
}
export const setupOptions = {
    modelProviders: MODEL_PROVIDERS,
    embeddingProviders: EMBEDDING_PROVIDERS,
    visibilities: VISIBILITIES,
    authTypes: AUTH_TYPES,
};
