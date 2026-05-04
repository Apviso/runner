import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { runCommand } from "./process.js";
import { redact } from "./log.js";
import { openAICodexToken } from "./providers.js";
const FULL_SHA256 = /^sha256:[a-fA-F0-9]{64}$/;
const SAFE_JOB_ID = /^[A-Za-z0-9_.:-]+$/;
const DEFAULT_SCAN_TIMEOUT_MS = 3 * 60 * 60 * 1000;
function providerEnv(config) {
    const env = { ...(config.providerEnv ?? {}) };
    delete env.OPENAI_CODEX_OAUTH_TOKEN;
    const copy = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
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
    const codexToken = config.modelProvider === "openai-codex" ? openAICodexToken(config) : undefined;
    if (codexToken)
        env.OPENAI_CODEX_OAUTH_TOKEN = codexToken;
    if (config.proxy) {
        env.HTTP_PROXY ??= config.proxy;
        env.HTTPS_PROXY ??= config.proxy;
    }
    return env;
}
function digestFromImageRef(ref) {
    const digest = ref.match(/@(?<digest>sha256:[a-fA-F0-9]{64})(?:$|[/?#])/i)?.groups?.digest;
    return digest?.toLowerCase();
}
export function imageReference(job) {
    const ref = job.image.ref || "ghcr.io/apviso/scan";
    const expectedDigest = job.image.digest.toLowerCase();
    const refDigest = digestFromImageRef(ref);
    if (ref.includes("@") && !refDigest) {
        throw new Error("Refusing scan image reference with an unsupported digest algorithm");
    }
    if (refDigest && refDigest !== expectedDigest) {
        throw new Error(`Scan image reference digest ${refDigest} does not match expected digest ${expectedDigest}`);
    }
    return refDigest ? ref : `${ref}@${job.image.digest}`;
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
    if (!FULL_SHA256.test(job.image.digest)) {
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
    await verifyPulledImageDigest(image, job.image.digest, signal);
    await verifyImageSignature(config, job, image, signal);
}
async function verifyPulledImageDigest(image, expectedDigest, signal) {
    const result = await runCommand("docker", ["image", "inspect", image, "--format", "{{json .RepoDigests}}"], {
        timeoutMs: 30_000,
        signal,
    });
    if (result.code !== 0) {
        throw new Error(`Image digest verification failed: ${redact(result.stderr || result.stdout)}`);
    }
    const repoDigests = JSON.parse(result.stdout.trim() || "[]");
    const digests = Array.isArray(repoDigests) ? repoDigests.filter((value) => typeof value === "string") : [];
    const expected = expectedDigest.toLowerCase();
    if (!digests.some((value) => digestFromImageRef(value) === expected)) {
        throw new Error(`Pulled scan image does not expose expected digest ${expected}`);
    }
}
function cosignVerifyArgs(job, image) {
    const args = ["verify"];
    const keyFile = process.env.APVISO_COSIGN_PUBLIC_KEY_FILE;
    const keyEnv = process.env.APVISO_COSIGN_PUBLIC_KEY
        ? "APVISO_COSIGN_PUBLIC_KEY"
        : process.env.COSIGN_PUBLIC_KEY
            ? "COSIGN_PUBLIC_KEY"
            : undefined;
    const identity = process.env.APVISO_COSIGN_CERT_IDENTITY;
    const identityRegexp = process.env.APVISO_COSIGN_CERT_IDENTITY_REGEXP || "^https://github.com/apviso/.+";
    const issuer = process.env.APVISO_COSIGN_CERT_OIDC_ISSUER || "https://token.actions.githubusercontent.com";
    const issuerRegexp = process.env.APVISO_COSIGN_CERT_OIDC_ISSUER_REGEXP;
    const signature = job.image.signature?.trim();
    if (keyFile) {
        args.push("--key", resolve(keyFile));
    }
    else if (keyEnv) {
        args.push("--key", `env://${keyEnv}`);
    }
    else {
        args.push(identity ? "--certificate-identity" : "--certificate-identity-regexp", identity || identityRegexp);
        args.push(issuerRegexp ? "--certificate-oidc-issuer-regexp" : "--certificate-oidc-issuer", issuerRegexp || issuer);
    }
    if (signature && existsSync(signature))
        args.push("--bundle", resolve(signature));
    args.push(image);
    return args;
}
async function verifyImageSignature(config, job, image, signal) {
    if (!config.requireImageSignature || config.allowUnsignedDevImages)
        return;
    const result = await runCommand("cosign", cosignVerifyArgs(job, image), {
        timeoutMs: 60_000,
        signal,
        maxBufferBytes: 256 * 1024,
    });
    if (result.code !== 0) {
        throw new Error(`Image signature verification failed: ${redact(result.stderr || result.stdout)}`);
    }
}
function scanTimeoutMs() {
    const raw = process.env.APVISO_SCAN_TIMEOUT_MS;
    if (!raw)
        return DEFAULT_SCAN_TIMEOUT_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error("APVISO_SCAN_TIMEOUT_MS must be a positive timeout in milliseconds");
    }
    return Math.floor(value);
}
function jobWorkspace(root, jobId) {
    if (!SAFE_JOB_ID.test(jobId))
        throw new Error("Refusing job ID with unsafe path characters");
    const workspaceRoot = resolve(root);
    const workspace = resolve(workspaceRoot, jobId);
    const safeRoot = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
    if (!workspace.startsWith(safeRoot))
        throw new Error("Refusing job workspace outside runner workspace");
    return workspace;
}
function jobSecretsDir(root, jobId) {
    if (!SAFE_JOB_ID.test(jobId))
        throw new Error("Refusing job ID with unsafe path characters");
    const secretsRoot = resolve(root, ".runner-secrets");
    const secretsDir = resolve(secretsRoot, jobId);
    const safeRoot = secretsRoot.endsWith(sep) ? secretsRoot : `${secretsRoot}${sep}`;
    if (!secretsDir.startsWith(safeRoot))
        throw new Error("Refusing job secrets directory outside runner workspace");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    chmodSync(secretsDir, 0o700);
    return secretsDir;
}
function writeEnvFile(secretsDir, env) {
    const path = resolve(secretsDir, "container.env");
    const lines = Object.entries(env).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error(`Invalid environment variable name: ${key}`);
        if (/[\r\n]/.test(value))
            throw new Error(`Environment variable ${key} cannot contain newlines in Docker env-file mode`);
        return `${key}=${value}`;
    });
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
}
function writeSecretFile(secretsDir, fileName, value) {
    if (!/^[A-Za-z0-9_.-]+$/.test(fileName))
        throw new Error(`Invalid secret file name: ${fileName}`);
    const path = resolve(secretsDir, fileName);
    writeFileSync(path, value, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
}
export async function runScanContainer(config, job, signal) {
    const workspace = jobWorkspace(config.workspaceDir, job.job.id);
    mkdirSync(workspace, { recursive: true });
    const secretsDir = jobSecretsDir(config.workspaceDir, job.job.id);
    const logsPath = join(workspace, "container.log");
    const logWriter = createRedactedLogWriter(logsPath);
    const image = imageReference(job);
    const containerName = `apviso-scan-${job.scan.id.slice(0, 12)}`;
    const env = {
        ...providerEnv(config),
        APVISO_API_URL: config.apiUrl,
        APVISO_SCAN_ID: job.scan.id,
        APVISO_RUNNER_JOB_ID: job.job.id,
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
        "--pull", "never",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", process.env.APVISO_SCAN_PIDS_LIMIT || "512",
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
    if (config.customCaPath) {
        const source = resolve(config.customCaPath);
        try {
            accessSync(source, constants.R_OK);
        }
        catch {
            throw new Error(`APVISO_CUSTOM_CA_PATH is not readable: ${source}`);
        }
        const customCaMountPath = "/run/secrets/apviso-custom-ca.pem";
        args.push("-v", `${source}:${customCaMountPath}:ro`);
        env.NODE_EXTRA_CA_CERTS = customCaMountPath;
        env.SSL_CERT_FILE ??= customCaMountPath;
        env.REQUESTS_CA_BUNDLE ??= customCaMountPath;
        env.CURL_CA_BUNDLE ??= customCaMountPath;
    }
    if (config.networkMode)
        args.push("--network", config.networkMode);
    const removeContainer = async () => {
        await runCommand("docker", ["rm", "-f", containerName], { timeoutMs: 30_000 }).catch(() => ({
            code: 1,
            stdout: "",
            stderr: "",
        }));
    };
    const abortCleanup = () => { void removeContainer(); };
    let result = null;
    try {
        const jobTokenPath = writeSecretFile(secretsDir, "job-token", job.jobToken);
        const scanTokenPath = writeSecretFile(secretsDir, "scan-token", job.scan.scanToken);
        const jobTokenMountPath = "/run/secrets/apviso-job-token";
        const scanTokenMountPath = "/run/secrets/apviso-scan-token";
        args.push("-v", `${jobTokenPath}:${jobTokenMountPath}:ro`);
        args.push("-v", `${scanTokenPath}:${scanTokenMountPath}:ro`);
        env.APVISO_JOB_TOKEN_FILE = jobTokenMountPath;
        env.APVISO_SCAN_TOKEN_FILE = scanTokenMountPath;
        if (process.env.APVISO_EXPOSE_JOB_TOKENS_IN_ENV === "true") {
            env.APVISO_JOB_TOKEN = job.jobToken;
            env.APVISO_SCAN_TOKEN = job.scan.scanToken;
        }
        const envFilePath = writeEnvFile(secretsDir, env);
        args.push("--env-file", envFilePath);
        args.push(image);
        if (signal?.aborted)
            abortCleanup();
        else
            signal?.addEventListener("abort", abortCleanup, { once: true });
        result = await runCommand("docker", args, {
            timeoutMs: scanTimeoutMs(),
            signal,
            onStdout: logWriter.write,
            onStderr: logWriter.write,
            maxBufferBytes: 64 * 1024,
        });
    }
    finally {
        signal?.removeEventListener("abort", abortCleanup);
        logWriter.end();
        rmSync(secretsDir, { recursive: true, force: true });
    }
    if (!result)
        throw new Error("Scan container did not return a command result");
    if (signal?.aborted || result.code === 124 || result.code === 130) {
        await removeContainer();
    }
    return { exitCode: result.code, logsPath };
}
function createRedactedLogWriter(logsPath) {
    let pending = "";
    writeFileSync(logsPath, "");
    return {
        write(chunk) {
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? "";
            for (const line of lines) {
                appendFileSync(logsPath, `${redact(line)}\n`);
            }
        },
        end() {
            if (!pending)
                return;
            appendFileSync(logsPath, redact(pending));
            pending = "";
        },
    };
}
