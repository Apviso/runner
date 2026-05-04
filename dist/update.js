import { platform } from "node:os";
import { RUNNER_VERSION } from "./config.js";
import { redact } from "./log.js";
import { runCommand } from "./process.js";
const DEFAULT_PACKAGE_NAME = "@apviso/runner";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const UPDATE_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 8_000;
export async function checkRunnerUpdate(options = {}) {
    const packageName = options.packageName || process.env.APVISO_RUNNER_PACKAGE || DEFAULT_PACKAGE_NAME;
    const currentVersion = options.currentVersion || RUNNER_VERSION;
    const checkedAt = new Date().toISOString();
    try {
        const latestVersion = await fetchLatestVersion({
            packageName,
            registry: options.registry || npmRegistry(),
            fetchRunner: options.fetch || fetch,
        });
        return {
            packageName,
            currentVersion,
            latestVersion,
            updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
            checkedAt,
        };
    }
    catch (err) {
        return {
            packageName,
            currentVersion,
            updateAvailable: false,
            checkedAt,
            error: redact(err instanceof Error ? err.message : String(err)),
        };
    }
}
export async function updateRunner(options = {}) {
    const status = options.status || await checkRunnerUpdate(options);
    if (status.error)
        throw new Error(`Could not check for runner updates: ${status.error}`);
    if (!status.updateAvailable || !status.latestVersion) {
        return {
            ...status,
            updated: false,
            pendingRestart: false,
            message: `APVISO Runner v${status.currentVersion} is already up to date.`,
        };
    }
    const packageSpec = `${status.packageName}@${status.latestVersion}`;
    const command = npmCommand();
    const runner = options.runCommand || runCommand;
    const result = await runner(command, ["install", "-g", packageSpec], {
        timeoutMs: UPDATE_TIMEOUT_MS,
        maxBufferBytes: 128 * 1024,
    });
    if (result.code !== 0) {
        throw new Error(formatInstallError(command, packageSpec, result));
    }
    return {
        ...status,
        updateAvailable: false,
        updated: true,
        pendingRestart: true,
        message: `Installed APVISO Runner v${status.latestVersion}. Restart the console or daemon to use it.`,
    };
}
function npmRegistry() {
    return process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || DEFAULT_NPM_REGISTRY;
}
function npmCommand() {
    return platform() === "win32" ? "npm.cmd" : "npm";
}
async function fetchLatestVersion(options) {
    const metadataUrl = `${normalizeRegistry(options.registry)}/${encodeURIComponent(options.packageName)}/latest`;
    const response = await options.fetchRunner(metadataUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`npm registry returned ${response.status} for ${options.packageName}`);
    const payload = await response.json();
    if (typeof payload.version !== "string" || !payload.version.trim()) {
        throw new Error(`npm registry response for ${options.packageName} did not include a version`);
    }
    return payload.version.trim();
}
function normalizeRegistry(value) {
    return value.trim().replace(/\/+$/, "") || DEFAULT_NPM_REGISTRY;
}
export function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right)
        return a.localeCompare(b, undefined, { numeric: true });
    for (const key of ["major", "minor", "patch"]) {
        if (left[key] !== right[key])
            return Math.sign(left[key] - right[key]);
    }
    return comparePrerelease(left.prerelease, right.prerelease);
}
function parseVersion(value) {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match)
        return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4]?.split(".") ?? [],
    };
}
function comparePrerelease(a, b) {
    if (a.length === 0 && b.length === 0)
        return 0;
    if (a.length === 0)
        return 1;
    if (b.length === 0)
        return -1;
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const left = a[index];
        const right = b[index];
        if (left === undefined)
            return -1;
        if (right === undefined)
            return 1;
        if (left === right)
            continue;
        const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
        const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
        if (leftNumber !== null && rightNumber !== null)
            return Math.sign(leftNumber - rightNumber);
        if (leftNumber !== null)
            return -1;
        if (rightNumber !== null)
            return 1;
        return left.localeCompare(right);
    }
    return 0;
}
function formatInstallError(command, packageSpec, result) {
    const output = redact([result.stderr, result.stdout].filter(Boolean).join("\n").trim());
    const detail = output ? `\n${tailLines(output, 20)}` : "";
    return `${command} install -g ${packageSpec} failed with exit code ${result.code ?? "unknown"}.${detail}`;
}
function tailLines(value, limit) {
    const lines = value.split(/\r?\n/);
    return lines.slice(-limit).join("\n");
}
