import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const MODEL_PROVIDERS = [
    "bedrock",
    "anthropic",
    "claude-code",
    "openai",
    "openai-codex",
    "github-copilot",
    "cloudflare-ai-gateway",
];
export const OPENAI_CODEX_AUTH_FILE_DISPLAY = "~/.codex/auth.json";
export const OPENAI_CODEX_LOGIN_REMEDIATION = `OpenAI Codex auth is required at ${OPENAI_CODEX_AUTH_FILE_DISPLAY}. Run \`codex login\` on the runner host to create it.`;
function env(name, source) {
    const value = (process.env[name] || source?.providerEnv?.[name])?.trim();
    return value ? value : undefined;
}
function isAnthropicOAuthToken(value) {
    return !!value && value.startsWith("sk-ant-oat");
}
function userHomeDir() {
    return process.env.HOME || process.env.USERPROFILE || homedir();
}
export function providerEnvValue(name, source) {
    return env(name, source);
}
export function hasOpenAIApiKey(source) {
    return !!env("OPENAI_API_KEY", source);
}
export function openAICodexAuthFilePath() {
    return join(userHomeDir(), ".codex", "auth.json");
}
export function hasOpenAICodexAuthFile() {
    try {
        accessSync(openAICodexAuthFilePath(), constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
export function hasOpenAICodexToken(_source) {
    return !!openAICodexToken(_source);
}
export function githubCopilotToken(source) {
    return env("COPILOT_GITHUB_TOKEN", source) || env("GH_TOKEN", source) || env("GITHUB_TOKEN", source);
}
export function hasGitHubCopilotToken(source) {
    return !!githubCopilotToken(source);
}
function hasGitHubCopilotAutoCredential(source) {
    return !!env("COPILOT_GITHUB_TOKEN", source);
}
export function openAICodexToken(source) {
    const token = env("OPENAI_CODEX_OAUTH_TOKEN", source);
    if (token)
        return token;
    try {
        const auth = JSON.parse(readFileSync(openAICodexAuthFilePath(), "utf8"));
        return typeof auth.tokens?.access_token === "string" && auth.tokens.access_token.trim()
            ? auth.tokens.access_token
            : undefined;
    }
    catch {
        return undefined;
    }
}
export function hasClaudeCodeToken(source) {
    return !!(env("CLAUDE_CODE_OAUTH_TOKEN", source) ||
        env("ANTHROPIC_OAUTH_TOKEN", source) ||
        env("ANTHROPIC_AUTH_TOKEN", source) ||
        isAnthropicOAuthToken(env("ANTHROPIC_API_KEY", source)));
}
export function hasAnthropicApiKey(source) {
    const key = env("ANTHROPIC_API_KEY", source);
    return !!key && !isAnthropicOAuthToken(key);
}
export function hasAnthropicCredential(source) {
    return hasAnthropicApiKey(source) || hasClaudeCodeToken(source);
}
export function missingCloudflareAiGatewayEnv(source) {
    return ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]
        .filter((name) => !env(name, source));
}
export function hasCloudflareAiGatewayCredentials(source) {
    return missingCloudflareAiGatewayEnv(source).length === 0;
}
export function hasBedrockCredentials(source) {
    return !!(env("AWS_BEARER_TOKEN_BEDROCK", source) ||
        (env("AWS_ACCESS_KEY_ID", source) && env("AWS_SECRET_ACCESS_KEY", source)) ||
        env("AWS_PROFILE", source) ||
        env("AWS_SHARED_CREDENTIALS_FILE", source) ||
        env("AWS_CONFIG_FILE", source) ||
        env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", source) ||
        env("AWS_CONTAINER_CREDENTIALS_FULL_URI", source) ||
        env("AWS_WEB_IDENTITY_TOKEN_FILE", source));
}
export function detectModelProvider(source) {
    if (hasOpenAIApiKey(source))
        return "openai";
    if (hasOpenAICodexAuthFile())
        return "openai-codex";
    if (hasGitHubCopilotAutoCredential(source))
        return "github-copilot";
    if (hasCloudflareAiGatewayCredentials(source))
        return "cloudflare-ai-gateway";
    if (hasAnthropicApiKey(source))
        return "anthropic";
    if (hasClaudeCodeToken(source))
        return "claude-code";
    if (hasBedrockCredentials(source))
        return "bedrock";
    return "anthropic";
}
export function providerState(modelProvider, embeddingProvider, source) {
    return {
        modelProvider,
        embeddingProvider,
        anthropic: hasAnthropicCredential(source),
        anthropicApi: hasAnthropicApiKey(source),
        claudeCode: hasClaudeCodeToken(source),
        bedrock: hasBedrockCredentials(source),
        openai: hasOpenAIApiKey(source),
        openaiCodex: hasOpenAICodexAuthFile(),
        githubCopilot: hasGitHubCopilotToken(source),
        cloudflareAiGateway: hasCloudflareAiGatewayCredentials(source),
        cloudflareAiGatewayMissing: missingCloudflareAiGatewayEnv(source),
    };
}
