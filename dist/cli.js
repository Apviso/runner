#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig, RUNNER_VERSION, saveConfig } from "./config.js";
import { RunnerDaemon } from "./daemon.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { redact } from "./log.js";
import { hasBedrockCredentials, hasOpenAICodexAuthFile, MODEL_PROVIDERS, OPENAI_CODEX_LOGIN_REMEDIATION, } from "./providers.js";
import { createPrompter, isPromptCancelled, promptChoice, promptNumber, promptRequired, promptSecret, promptString, promptYesNo, } from "./prompts.js";
import { defaultTargetAuthPath, expandHome, upsertTargetAuthConfig, } from "./target-auth.js";
import { addTargetAuth, AUTH_TYPES, createTarget, EMBEDDING_PROVIDERS, mergeProviderEnv, onboardRunner, registerRunner, tokenNamespace, VISIBILITIES, } from "./setup.js";
import { startConsoleCommand } from "./console.js";
import * as ui from "./ui.js";
function parseCookieHeader(header) {
    return header
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
        const [name = "", ...valueParts] = part.split("=");
        return { name: name.trim(), value: valueParts.join("=").trim(), path: "/" };
    })
        .filter((cookie) => cookie.name && cookie.value);
}
export function parseCliArgs(argv) {
    const first = argv[0];
    const defaultToUi = first === undefined || (first.startsWith("-") && first !== "--help" && first !== "-h");
    const command = defaultToUi ? "ui" : first;
    const [, maybeSubcommand, ...rest] = argv;
    const hasSubcommand = command === "add" && maybeSubcommand && !maybeSubcommand.startsWith("-");
    const args = defaultToUi ? argv : hasSubcommand ? rest : argv.slice(1);
    const flags = {};
    const positionals = [];
    for (let index = 0; index < args.length; index += 1) {
        const item = args[index];
        if (!item.startsWith("--")) {
            positionals.push(item);
            continue;
        }
        const withoutPrefix = item.slice(2);
        const [rawKey, inlineValue] = withoutPrefix.split(/=(.*)/s, 2);
        const key = rawKey;
        if (inlineValue !== undefined) {
            setFlag(flags, key, inlineValue);
            continue;
        }
        const next = args[index + 1];
        if (next && !next.startsWith("--")) {
            setFlag(flags, key, next);
            index += 1;
        }
        else {
            setFlag(flags, key, true);
        }
    }
    return {
        command,
        subcommand: hasSubcommand ? maybeSubcommand : undefined,
        flags,
        positionals,
    };
}
function usage() {
    return `APVISO Runner ${RUNNER_VERSION}

Usage:
  apviso [options]
  apviso <command> [options]

Commands:
  (no command)             Start the local web console
  onboard                  Configure and register this runner, or attach an existing runner token
  run                      Start polling for APVISO scan jobs
  ui, start [--host 127.0.0.1] [--port 0] [--no-open]
                           Start the local web console
  doctor [--json]          Run local and cloud readiness checks
  add target [target]       Create a cloud target and optional runner-local auth
  add target-auth [target]  Add runner-local auth for an existing target ID, domain, or URL
  register --token <enrollment-token|runner-token> [--name local-runner]
                            Register with an enrollment token or store a rotated runner token
  unregister                Show cleanup guidance for this runner
  logs                      Show where job container logs are written
  version                   Print the runner version

Environment:
  APVISO_API_URL, APVISO_API_KEY, APVISO_RUNNER_TOKEN, APVISO_MODEL_PROVIDER,
  APVISO_EMBEDDING_PROVIDER, APVISO_REQUIRE_IMAGE_SIGNATURE,
  APVISO_ALLOW_UNSIGNED_DEV_IMAGES, APVISO_TARGET_AUTH_CONFIG_FILE,
  ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN/OPENAI_API_KEY/COPILOT_GITHUB_TOKEN/CLOUDFLARE_API_KEY/AWS_*
  OpenAI Codex uses ~/.codex/auth.json from \`codex login\`.
`;
}
function setFlag(flags, key, value) {
    const current = flags[key];
    if (current === undefined) {
        flags[key] = value;
        return;
    }
    const nextValue = value === true ? "true" : value;
    flags[key] = Array.isArray(current)
        ? [...current, nextValue]
        : [current === true ? "true" : current, nextValue];
}
function flag(flags, name) {
    const value = flags[name];
    if (Array.isArray(value))
        return value.at(-1);
    return typeof value === "string" ? value : undefined;
}
function flagValues(flags, name) {
    const value = flags[name];
    if (Array.isArray(value))
        return value;
    return typeof value === "string" ? [value] : [];
}
function flagList(flags, ...names) {
    return names
        .flatMap((name) => flagValues(flags, name))
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
}
function flagBool(flags, name) {
    const value = flags[name];
    if (Array.isArray(value))
        return value.includes("true");
    return flags[name] === true || flags[name] === "true";
}
function authTypesFromFlags(flags) {
    return flagList(flags, "auth-type", "auth-types").map((value) => {
        if (AUTH_TYPES.includes(value))
            return value;
        throw new Error(`--auth-type must be one of: ${AUTH_TYPES.join(", ")}`);
    });
}
function normalizeDomain(input) {
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
async function promptOptionalPath(prompter, label, current) {
    const answer = await promptString(prompter, label, current);
    return answer ? expandHome(answer) : undefined;
}
function currentProviderSecret(config, name) {
    return config.providerEnv?.[name] || process.env[name];
}
async function promptProviderSecret(prompter, config, name, label = name) {
    return promptSecret(prompter, label, currentProviderSecret(config, name));
}
async function promptModelProviderEnv(prompter, provider, current) {
    if (provider === "anthropic") {
        const value = await promptProviderSecret(prompter, current, "ANTHROPIC_API_KEY");
        if (!value)
            throw new Error("ANTHROPIC_API_KEY is required for the anthropic model provider.");
        return { ANTHROPIC_API_KEY: value };
    }
    if (provider === "claude-code") {
        const value = await promptProviderSecret(prompter, current, "CLAUDE_CODE_OAUTH_TOKEN");
        if (!value)
            throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for the claude-code model provider.");
        return { CLAUDE_CODE_OAUTH_TOKEN: value };
    }
    if (provider === "openai") {
        const value = await promptProviderSecret(prompter, current, "OPENAI_API_KEY");
        if (!value)
            throw new Error("OPENAI_API_KEY is required for the openai model provider.");
        return { OPENAI_API_KEY: value };
    }
    if (provider === "openai-codex") {
        if (!hasOpenAICodexAuthFile())
            throw new Error(OPENAI_CODEX_LOGIN_REMEDIATION);
        return undefined;
    }
    if (provider === "github-copilot") {
        const value = await promptProviderSecret(prompter, current, "COPILOT_GITHUB_TOKEN");
        if (!value)
            throw new Error("COPILOT_GITHUB_TOKEN is required for the github-copilot model provider.");
        return { COPILOT_GITHUB_TOKEN: value };
    }
    if (provider === "cloudflare-ai-gateway") {
        const apiKey = await promptProviderSecret(prompter, current, "CLOUDFLARE_API_KEY");
        if (!apiKey)
            throw new Error("CLOUDFLARE_API_KEY is required for the cloudflare-ai-gateway model provider.");
        const accountId = await promptString(prompter, "CLOUDFLARE_ACCOUNT_ID", currentProviderSecret(current, "CLOUDFLARE_ACCOUNT_ID"));
        if (!accountId)
            throw new Error("CLOUDFLARE_ACCOUNT_ID is required for the cloudflare-ai-gateway model provider.");
        const gatewayId = await promptString(prompter, "CLOUDFLARE_GATEWAY_ID", currentProviderSecret(current, "CLOUDFLARE_GATEWAY_ID"));
        if (!gatewayId)
            throw new Error("CLOUDFLARE_GATEWAY_ID is required for the cloudflare-ai-gateway model provider.");
        return {
            CLOUDFLARE_API_KEY: apiKey,
            CLOUDFLARE_ACCOUNT_ID: accountId,
            CLOUDFLARE_GATEWAY_ID: gatewayId,
        };
    }
    if (hasBedrockCredentials(current))
        return undefined;
    const value = await promptProviderSecret(prompter, current, "AWS_BEARER_TOKEN_BEDROCK");
    if (!value) {
        throw new Error("Bedrock credentials are required. Provide AWS_BEARER_TOKEN_BEDROCK or configure AWS credentials in the runner environment.");
    }
    return { AWS_BEARER_TOKEN_BEDROCK: value };
}
async function promptEmbeddingProviderEnv(prompter, embeddingProvider, current, providerEnv) {
    if (embeddingProvider !== "bedrock-cohere")
        return undefined;
    const configWithUpdates = { ...current, providerEnv: mergeProviderEnv(current.providerEnv, providerEnv ?? {}) };
    if (hasBedrockCredentials(configWithUpdates))
        return undefined;
    const value = await promptProviderSecret(prompter, configWithUpdates, "AWS_BEARER_TOKEN_BEDROCK");
    if (!value) {
        throw new Error("AWS_BEARER_TOKEN_BEDROCK or AWS credentials are required for bedrock-cohere embeddings.");
    }
    return { AWS_BEARER_TOKEN_BEDROCK: value };
}
async function commandRegister(parsed) {
    const enrollmentToken = flag(parsed.flags, "token") || process.env.APVISO_RUNNER_ENROLLMENT_TOKEN;
    if (!enrollmentToken)
        throw new Error("Missing --token or APVISO_RUNNER_ENROLLMENT_TOKEN");
    const config = loadConfig();
    const name = flag(parsed.flags, "name") || config.runnerName;
    const namespace = tokenNamespace(enrollmentToken);
    if (namespace === "apvr") {
        await registerRunner({ token: enrollmentToken, name });
        ui.success(`Runner token stored at ${configPath()}.`);
        return 0;
    }
    if (namespace !== "apve") {
        throw new Error("Expected an enrollment token starting with apve_ or a runner token starting with apvr_.");
    }
    const result = await ui.withSpinner("Registering runner", () => registerRunner({ token: enrollmentToken, name }), (registered) => `Registered runner ${registered.runner?.name ?? name}`);
    void result;
    ui.success(`Token stored at ${configPath()}.`);
    return 0;
}
async function commandDoctor(parsed) {
    const config = loadConfig();
    const json = flagBool(parsed.flags, "json");
    const result = json
        ? await runDoctor(config)
        : await ui.withSpinner("Running readiness checks", () => runDoctor(config), "Readiness checks complete");
    if (json)
        console.log(JSON.stringify(result, null, 2));
    else
        ui.message(formatDoctor(result));
    return result.ok ? 0 : 2;
}
async function commandRun() {
    const config = loadConfig();
    const daemon = new RunnerDaemon(config);
    await daemon.run();
    return 0;
}
export async function commandOnboard(parsed, prompter = createPrompter()) {
    try {
        ui.startScreen("Onboarding");
        ui.info("Answer a few local setup questions. Secrets stay on this machine.");
        const current = loadConfig();
        const apiUrl = flag(parsed.flags, "api-url") ||
            await promptRequired(prompter, "APVISO API URL", current.apiUrl);
        const apiCredential = flag(parsed.flags, "api-key") ||
            await promptSecret(prompter, "APVISO API key, enrollment token, or runner token", current.apiKey || current.token);
        if (!apiCredential)
            throw new Error("APVISO API key, enrollment token, or runner token is required for onboarding.");
        const apiCredentialNamespace = tokenNamespace(apiCredential);
        const providedRunnerToken = apiCredentialNamespace === "apvr" ? apiCredential : undefined;
        const providedEnrollmentToken = apiCredentialNamespace === "apve" ? apiCredential : undefined;
        if (apiCredentialNamespace === "apvj") {
            throw new Error("Job-scoped tokens cannot onboard a runner. Use an apvk_ API key, apve_ enrollment token, or apvr_ runner token.");
        }
        const runnerName = flag(parsed.flags, "name") ||
            await promptRequired(prompter, "Runner name", current.runnerName);
        const modelProvider = (flag(parsed.flags, "model-provider") ||
            await promptChoice(prompter, "Model provider", MODEL_PROVIDERS, current.modelProvider));
        const modelProviderEnv = await promptModelProviderEnv(prompter, modelProvider, current);
        const embeddingProvider = (flag(parsed.flags, "embedding-provider") ||
            await promptChoice(prompter, "Embedding provider", EMBEDDING_PROVIDERS, current.embeddingProvider));
        const embeddingProviderEnv = await promptEmbeddingProviderEnv(prompter, embeddingProvider, current, modelProviderEnv);
        const providerEnv = mergeProviderEnv(current.providerEnv, mergeProviderEnv(modelProviderEnv, embeddingProviderEnv));
        const concurrency = flag(parsed.flags, "concurrency")
            ? Number(flag(parsed.flags, "concurrency"))
            : await promptNumber(prompter, "Concurrent jobs", current.concurrency);
        if (!Number.isFinite(concurrency) || concurrency <= 0)
            throw new Error("Concurrency must be a positive number.");
        const workspaceDir = expandHome(flag(parsed.flags, "workspace") ||
            await promptRequired(prompter, "Workspace directory", current.workspaceDir));
        const networkMode = flag(parsed.flags, "network") ||
            await promptString(prompter, "Docker network mode (blank for default)", current.networkMode);
        const proxy = flag(parsed.flags, "proxy") ||
            await promptString(prompter, "HTTP(S) proxy (blank for none)", current.proxy);
        const customCaPath = flag(parsed.flags, "custom-ca") ||
            await promptOptionalPath(prompter, "Custom CA path (blank for none)", current.customCaPath);
        const targetAuthConfigFile = flag(parsed.flags, "target-auth-file") ||
            await promptOptionalPath(prompter, "Target auth config file (blank for none)", current.targetAuthConfigFile);
        ui.step("Saving runner configuration");
        const onboarding = await ui.withSpinner(providedRunnerToken
            ? "Verifying runner token"
            : providedEnrollmentToken
                ? "Registering runner"
                : "Creating enrollment token and registering runner", () => onboardRunner({
            apiUrl,
            apiCredential,
            runnerName,
            modelProvider,
            embeddingProvider,
            providerEnv,
            concurrency,
            workspaceDir,
            networkMode,
            proxy,
            customCaPath,
            targetAuthConfigFile,
        }), providedRunnerToken ? "Runner token verified" : "Runner registered");
        ui.success(`Token stored at ${configPath()}.`);
        ui.message(formatDoctor(onboarding.doctor));
        ui.endScreen(onboarding.doctor.ok ? "Runner is ready. Start it with `apviso run`." : "Onboarding finished, but checks need attention.");
        return onboarding.doctor.ok ? 0 : 2;
    }
    finally {
        prompter.close?.();
    }
}
async function promptTargetAuth(prompter, forcedType) {
    const type = (forcedType ||
        await promptChoice(prompter, "Target auth type", AUTH_TYPES, "none"));
    if (type === "none")
        return null;
    if (type === "bearer")
        return { type, token: await promptRequired(prompter, "Bearer token") };
    if (type === "basic") {
        return {
            type,
            username: await promptRequired(prompter, "Basic auth username"),
            password: await promptRequired(prompter, "Basic auth password"),
        };
    }
    if (type === "cookie") {
        return {
            type,
            cookieName: await promptRequired(prompter, "Cookie name"),
            cookieValue: await promptRequired(prompter, "Cookie value"),
        };
    }
    if (type === "cookies") {
        const cookieHeader = await promptRequired(prompter, "Cookie header (name=value; other=value)");
        const cookies = parseCookieHeader(cookieHeader);
        if (cookies.length === 0)
            throw new Error("At least one cookie is required.");
        return { type, cookies };
    }
    if (type === "api_key") {
        return {
            type,
            headerName: await promptRequired(prompter, "API key header name", "X-API-Key"),
            headerValue: await promptRequired(prompter, "API key header value"),
        };
    }
    if (type === "login") {
        return {
            type,
            loginUrl: await promptRequired(prompter, "Login URL"),
            username: await promptRequired(prompter, "Login username"),
            password: await promptRequired(prompter, "Login password"),
        };
    }
    if (type === "custom_headers") {
        const headers = [];
        while (true) {
            const name = await promptString(prompter, "Header name (blank to finish)");
            if (!name)
                break;
            headers.push({ name, value: await promptRequired(prompter, `Value for ${name}`) });
        }
        if (headers.length === 0)
            throw new Error("At least one custom header is required.");
        return { type, headers };
    }
    if (type === "browser_state") {
        const path = expandHome(await promptRequired(prompter, "Playwright storageState JSON file"));
        const storageState = JSON.parse(readFileSync(path, "utf8"));
        return { type, storageState };
    }
    throw new Error(`Unsupported auth type: ${type}`);
}
async function promptTargetAuths(prompter, forcedTypes = []) {
    if (forcedTypes.length > 0) {
        const auths = [];
        for (const type of forcedTypes) {
            const auth = await promptTargetAuth(prompter, type);
            if (auth)
                auths.push(auth);
        }
        return auths;
    }
    const first = await promptTargetAuth(prompter);
    if (!first)
        return [];
    const auths = [first];
    while (await promptYesNo(prompter, "Add another auth for this target?", false)) {
        const next = await promptTargetAuth(prompter);
        if (!next)
            break;
        auths.push(next);
    }
    return auths;
}
async function maybeSaveTargetAuth(prompter, config, target, forcedAuthTypes = [], options = {}) {
    const shouldConfigure = forcedAuthTypes.length > 0
        ? forcedAuthTypes.some((type) => type !== "none")
        : options.promptToConfigure === false
            ? true
            : await promptYesNo(prompter, "Configure runner-local auth for this target?", false);
    if (!shouldConfigure)
        return;
    const auths = await promptTargetAuths(prompter, forcedAuthTypes);
    if (auths.length === 0)
        return;
    const filePath = options.authFilePath ||
        config.targetAuthConfigFile ||
        await promptRequired(prompter, "Target auth config file", defaultTargetAuthPath());
    upsertTargetAuthConfig(filePath, target, auths, { mode: options.mode ?? "append" });
    if (!config.targetAuthConfigFile)
        saveConfig({ targetAuthConfigFile: expandHome(filePath) });
    ui.success(`Updated runner-local auth config at ${expandHome(filePath)} with ${auths.length} auth entr${auths.length === 1 ? "y" : "ies"}.`);
}
async function commandAddTarget(parsed, prompter = createPrompter()) {
    try {
        const config = loadConfig();
        if (!config.apiKey)
            throw new Error("APVISO_API_KEY is required. Run `apviso onboard` first.");
        const rawTarget = flag(parsed.flags, "target") ||
            parsed.positionals[0] ||
            await promptRequired(prompter, "Target display URL or domain");
        const visibility = (flag(parsed.flags, "visibility") ||
            await promptChoice(prompter, "Target visibility", VISIBILITIES, "public"));
        const rawScanUrl = flag(parsed.flags, "scan-url") ||
            await promptString(prompter, "Runtime scan URL (blank to use display URL)");
        const partnerClientId = flag(parsed.flags, "partner-client-id") ||
            (visibility === "partner_client" ? await promptRequired(prompter, "Partner client ID") : "");
        const result = await ui.withSpinner("Creating target", () => createTarget({
            target: rawTarget,
            scanUrl: rawScanUrl || undefined,
            visibility,
            partnerClientId: partnerClientId || undefined,
        }), (created) => `Created target ${created.target.domain}`);
        ui.info(`Target ID: ${result.target.id}`);
        await maybeSaveTargetAuth(prompter, config, result.target, authTypesFromFlags(parsed.flags), {
            authFilePath: flag(parsed.flags, "target-auth-file"),
        });
        return 0;
    }
    finally {
        prompter.close?.();
    }
}
export async function commandAddTargetAuth(parsed, prompter = createPrompter()) {
    try {
        const config = loadConfig();
        const rawTarget = flag(parsed.flags, "target") ||
            parsed.positionals[0] ||
            await promptRequired(prompter, "Target ID, domain, or URL");
        const targetId = flag(parsed.flags, "target-id") || rawTarget;
        const domain = flag(parsed.flags, "domain") || normalizeDomain(rawTarget);
        const displayUrl = flag(parsed.flags, "display-url") ||
            (rawTarget.includes("://") ? rawTarget : domain || rawTarget);
        const scanUrl = flag(parsed.flags, "scan-url") ||
            await promptString(prompter, "Runtime scan URL (blank to omit)");
        const auths = await promptTargetAuths(prompter, authTypesFromFlags(parsed.flags));
        if (auths.length === 0)
            return 0;
        const authFile = flag(parsed.flags, "target-auth-file") ||
            config.targetAuthConfigFile ||
            await promptRequired(prompter, "Target auth config file", defaultTargetAuthPath());
        const result = addTargetAuth({
            target: rawTarget,
            targetId,
            domain,
            displayUrl,
            scanUrl: scanUrl || undefined,
            auth: auths,
            targetAuthFile: authFile,
            authMode: "append",
        });
        ui.success(`Updated runner-local auth config at ${result.authFile} with ${auths.length} auth entr${auths.length === 1 ? "y" : "ies"}.`);
        return 0;
    }
    finally {
        prompter.close?.();
    }
}
async function commandUnregister() {
    ui.warning(`Remove or revoke this runner from the APVISO dashboard, then delete ${configPath()}.`);
    return 0;
}
async function commandLogs() {
    const config = loadConfig();
    ui.info(`Workspace logs live under ${config.workspaceDir}/<job-id>/container.log`);
    return 0;
}
export async function runCli(argv = process.argv.slice(2)) {
    const parsed = parseCliArgs(argv);
    if (parsed.command === "onboard")
        return commandOnboard(parsed);
    if (parsed.command === "register")
        return commandRegister(parsed);
    if (parsed.command === "doctor")
        return commandDoctor(parsed);
    if (parsed.command === "run")
        return commandRun();
    if (parsed.command === "ui" || parsed.command === "start") {
        const port = flag(parsed.flags, "port") ? Number(flag(parsed.flags, "port")) : 0;
        if (!Number.isInteger(port) || port < 0 || port > 65_535)
            throw new Error("--port must be a valid TCP port.");
        return startConsoleCommand({
            host: flag(parsed.flags, "host") || "127.0.0.1",
            port,
            open: !flagBool(parsed.flags, "no-open"),
        });
    }
    if (parsed.command === "add" && parsed.subcommand === "target")
        return commandAddTarget(parsed);
    if (parsed.command === "add" && parsed.subcommand === "target-auth")
        return commandAddTargetAuth(parsed);
    if (parsed.command === "unregister")
        return commandUnregister();
    if (parsed.command === "logs")
        return commandLogs();
    if (parsed.command === "version") {
        console.log(RUNNER_VERSION);
        return 0;
    }
    console.log(usage());
    return parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h" ? 0 : 1;
}
function isMainModule() {
    const entrypoint = process.argv[1];
    if (!entrypoint)
        return false;
    const currentFile = fileURLToPath(import.meta.url);
    try {
        return realpathSync(entrypoint) === realpathSync(currentFile);
    }
    catch {
        return entrypoint === currentFile;
    }
}
if (isMainModule()) {
    try {
        const code = await runCli();
        process.exit(code);
    }
    catch (err) {
        if (isPromptCancelled(err))
            process.exit(130);
        console.error(redact(err instanceof Error ? err.message : String(err)));
        process.exit(1);
    }
}
