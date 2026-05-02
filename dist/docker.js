import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./process.js";
import { redact } from "./log.js";
import { openAICodexToken } from "./providers.js";
function providerEnv(config) {
    const env = { ...(config.providerEnv ?? {}) };
    const copy = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "OPENAI_CODEX_OAUTH_TOKEN",
        "COPILOT_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_GATEWAY_ID",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_PROFILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_CONFIG_FILE",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_ROLE_ARN",
        "AWS_ROLE_SESSION_NAME",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
    ];
    for (const key of copy) {
        const value = process.env[key];
        if (value)
            env[key] = value;
    }
    const codexToken = openAICodexToken(config);
    if (!env.OPENAI_CODEX_OAUTH_TOKEN && codexToken)
        env.OPENAI_CODEX_OAUTH_TOKEN = codexToken;
    if (config.proxy) {
        env.HTTP_PROXY ??= config.proxy;
        env.HTTPS_PROXY ??= config.proxy;
    }
    return env;
}
export function imageReference(job) {
    const ref = job.image.ref || "ghcr.io/apviso/scan";
    return ref.includes("@sha256:") ? ref : `${ref}@${job.image.digest}`;
}
export function containerTargetScanUrl(scanUrl, visibility) {
    if (visibility !== "localhost")
        return scanUrl;
    try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(scanUrl) ? scanUrl : `http://${scanUrl}`);
        const host = parsed.hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]") {
            parsed.hostname = "host.docker.internal";
            return parsed.toString();
        }
    }
    catch {
        return scanUrl;
    }
    return scanUrl;
}
export async function pullAndVerifyImage(config, job, signal) {
    if (!/^sha256:[a-fA-F0-9]{64}$/.test(job.image.digest)) {
        throw new Error("Refusing to run scan image without a full sha256 digest");
    }
    if (config.requireImageSignature && !job.image.signature && !config.allowUnsignedDevImages) {
        throw new Error("Refusing unsigned scan image");
    }
    const image = imageReference(job);
    const result = await runCommand("docker", ["pull", image], { timeoutMs: 5 * 60_000, signal });
    if (result.code !== 0) {
        throw new Error(`Image pull failed: ${redact(result.stderr || result.stdout)}`);
    }
}
export async function runScanContainer(config, job, signal) {
    const workspace = join(config.workspaceDir, job.job.id);
    mkdirSync(workspace, { recursive: true });
    const logsPath = join(workspace, "container.log");
    const image = imageReference(job);
    const containerName = `apviso-scan-${job.scan.id.slice(0, 12)}`;
    const env = {
        ...providerEnv(config),
        APVISO_API_URL: config.apiUrl,
        APVISO_SCAN_ID: job.scan.id,
        APVISO_RUNNER_JOB_ID: job.job.id,
        APVISO_JOB_TOKEN: job.jobToken,
        APVISO_SCAN_TOKEN: job.scan.scanToken,
        APVISO_MODEL_PRESET: job.scan.modelPreset,
        APVISO_MODEL_PROVIDER: config.modelProvider,
        APVISO_EMBEDDING_PROVIDER: config.embeddingProvider,
        APVISO_SCAN_IMAGE_DIGEST: job.image.digest,
        SCAN_ALLOW_INTERNAL_TARGETS: ["private_internal", "localhost", "partner_client"].includes(job.target.visibility) ? "true" : "false",
    };
    const targetAuthMountPath = "/run/secrets/apviso-target-auth.json";
    const args = [
        "run",
        "--rm",
        "--name", containerName,
        "--add-host", "host.docker.internal:host-gateway",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
        "-v", `${workspace}:/data`,
        "--cpus", process.env.APVISO_SCAN_CPUS || "2",
        "--memory", process.env.APVISO_SCAN_MEMORY || "4g",
    ];
    if (config.targetAuthConfigFile) {
        const source = resolve(config.targetAuthConfigFile);
        try {
            accessSync(source, constants.R_OK);
        }
        catch {
            throw new Error(`APVISO_TARGET_AUTH_CONFIG_FILE is not readable: ${source}`);
        }
        args.push("-v", `${source}:${targetAuthMountPath}:ro`);
        env.APVISO_TARGET_AUTH_CONFIG_FILE = targetAuthMountPath;
    }
    if (config.networkMode)
        args.push("--network", config.networkMode);
    for (const [key, value] of Object.entries(env)) {
        args.push("-e", `${key}=${value}`);
    }
    args.push(image);
    const removeContainer = async () => {
        await runCommand("docker", ["rm", "-f", containerName], { timeoutMs: 30_000 }).catch(() => ({
            code: 1,
            stdout: "",
            stderr: "",
        }));
    };
    const abortCleanup = () => { void removeContainer(); };
    if (signal?.aborted)
        abortCleanup();
    else
        signal?.addEventListener("abort", abortCleanup, { once: true });
    let result = null;
    try {
        result = await runCommand("docker", args, {
            timeoutMs: Number(process.env.APVISO_SCAN_TIMEOUT_MS || 3 * 60 * 60 * 1000),
            signal,
        });
    }
    finally {
        signal?.removeEventListener("abort", abortCleanup);
    }
    if (!result)
        throw new Error("Scan container did not return a command result");
    if (signal?.aborted || result.code === 124 || result.code === 130) {
        await removeContainer();
    }
    writeFileSync(logsPath, redact(`${result.stdout}\n${result.stderr}`));
    return { exitCode: result.code, logsPath };
}
