import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { detectModelProvider, MODEL_PROVIDERS } from "./providers.js";
export const RUNNER_VERSION = "0.1.2";
export function normalizeApiUrl(input) {
    const trimmed = input.trim().replace(/\/+$/, "");
    const lower = trimmed.toLowerCase();
    for (const suffix of ["/api/v1", "/v1", "/api"]) {
        if (lower.endsWith(suffix))
            return trimmed.slice(0, -suffix.length) || trimmed;
    }
    return trimmed;
}
function isRunnerScopedToken(value) {
    return !!value?.trim().startsWith("apvr_");
}
function resolvedConfigPath() {
    return process.env.APVISO_RUNNER_CONFIG ||
        join(homedir(), ".apviso-runner", "config.json");
}
function readStoredConfig() {
    const path = configPath();
    if (!existsSync(path))
        return {};
    return JSON.parse(readFileSync(path, "utf8"));
}
export function saveConfig(config) {
    const existing = readStoredConfig();
    const next = {
        ...existing,
        ...config,
    };
    if (next.apiUrl)
        next.apiUrl = normalizeApiUrl(next.apiUrl);
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}
export function saveRunnerToken(token, apiUrl, runnerName) {
    saveConfig({ apiUrl: normalizeApiUrl(apiUrl), token, runnerName });
}
function numberEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${name} must be a positive number`);
    return value;
}
function modelProviderEnv(stored, providerEnv) {
    const value = (process.env.APVISO_MODEL_PROVIDER ||
        stored ||
        detectModelProvider(providerEnv ? { providerEnv } : undefined));
    if (!MODEL_PROVIDERS.includes(value)) {
        throw new Error(`APVISO_MODEL_PROVIDER must be ${MODEL_PROVIDERS.join(", ")}`);
    }
    return value;
}
function embeddingEnv(stored) {
    const value = (process.env.APVISO_EMBEDDING_PROVIDER || stored || "local");
    if (!["bedrock-cohere", "local"].includes(value)) {
        throw new Error("APVISO_EMBEDDING_PROVIDER must be bedrock-cohere or local");
    }
    return value;
}
function booleanEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined)
        return fallback;
    return raw === "true";
}
function storedProviderEnv(stored) {
    if (!stored)
        return undefined;
    const entries = Object.entries(stored)
        .map(([key, value]) => [key.trim(), value.trim()])
        .filter(([key, value]) => key && value);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
export function loadConfig() {
    const stored = readStoredConfig();
    const providerEnv = storedProviderEnv(stored.providerEnv);
    const apiUrl = normalizeApiUrl(process.env.APVISO_API_URL || stored.apiUrl || "http://localhost:3001");
    const envApiKey = process.env.APVISO_API_KEY;
    const apiKey = isRunnerScopedToken(envApiKey)
        ? undefined
        : envApiKey || (isRunnerScopedToken(stored.apiKey) ? undefined : stored.apiKey);
    const token = process.env.APVISO_RUNNER_TOKEN ||
        (isRunnerScopedToken(envApiKey) ? envApiKey : undefined) ||
        stored.token ||
        (isRunnerScopedToken(stored.apiKey) ? stored.apiKey : undefined);
    const workspaceDir = process.env.APVISO_RUNNER_WORKSPACE ||
        stored.workspaceDir ||
        join(process.cwd(), "workspace");
    const runnerName = process.env.APVISO_RUNNER_NAME || stored.runnerName || "local-runner";
    const config = {
        apiUrl,
        apiKey,
        token,
        workspaceDir,
        runnerName,
        containerEngine: "docker",
        concurrency: numberEnv("APVISO_RUNNER_CONCURRENCY", stored.concurrency ?? 1),
        pollIntervalMs: numberEnv("APVISO_RUNNER_POLL_INTERVAL_MS", stored.pollIntervalMs ?? 5_000),
        heartbeatIntervalMs: numberEnv("APVISO_RUNNER_HEARTBEAT_INTERVAL_MS", stored.heartbeatIntervalMs ?? 15_000),
        modelProvider: modelProviderEnv(stored.modelProvider, providerEnv),
        embeddingProvider: embeddingEnv(stored.embeddingProvider),
        providerEnv,
        networkMode: process.env.APVISO_RUNNER_NETWORK || stored.networkMode,
        proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || stored.proxy,
        customCaPath: process.env.APVISO_CUSTOM_CA_PATH || stored.customCaPath,
        targetAuthConfigFile: process.env.APVISO_TARGET_AUTH_CONFIG_FILE || stored.targetAuthConfigFile,
        requireImageSignature: booleanEnv("APVISO_REQUIRE_IMAGE_SIGNATURE", stored.requireImageSignature ?? false),
        allowUnsignedDevImages: booleanEnv("APVISO_ALLOW_UNSIGNED_DEV_IMAGES", stored.allowUnsignedDevImages ?? false),
    };
    mkdirSync(config.workspaceDir, { recursive: true });
    return config;
}
export function configPath() {
    return resolvedConfigPath();
}
