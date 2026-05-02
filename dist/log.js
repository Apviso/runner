const SECRET_PATTERNS = [
    /apvr_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+/g,
    /apve_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+/g,
    /apvj_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+/g,
    /apvk_[A-Za-z0-9_-]+/g,
    /sk-[A-Za-z0-9_-]{16,}/g,
    /sk-ant-[A-Za-z0-9_-]{16,}/g,
    /((?:AWS_BEARER_TOKEN_BEDROCK|AWS_SECRET_ACCESS_KEY|OPENAI_CODEX_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|CLOUDFLARE_API_KEY)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
    /(authorization:\s*bearer\s+)[^\s]+/gi,
    /([A-Za-z0-9_]*API_KEY=)[^\s]+/g,
];
const ANSI = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
};
const LEVEL_COLORS = {
    info: ANSI.cyan,
    warn: ANSI.yellow,
    error: ANSI.red,
};
export function redact(value) {
    let text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    for (const pattern of SECRET_PATTERNS) {
        text = text.replace(pattern, (match, prefix) => `${typeof prefix === "string" ? prefix : ""}[redacted]`);
    }
    return text;
}
function redactedValue(value) {
    const text = redact(value);
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function formatKey(key) {
    return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key);
}
function formatLabel(key) {
    return formatKey(key)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_.-]+/g, " ")
        .toLowerCase();
}
function formatValue(value) {
    if (typeof value === "string") {
        if (!value.includes("\n") && !value.includes("\r"))
            return value;
        return JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
        return String(value);
    if (value === null)
        return "null";
    return JSON.stringify(value) ?? String(value);
}
function formatMetaFields(meta) {
    const value = redactedValue(meta);
    if (isRecord(value)) {
        return Object.entries(value).map(([key, entry]) => [formatLabel(key), formatValue(entry)]);
    }
    return [["detail", formatValue(value)]];
}
function color(text, code, enabled) {
    return enabled ? `${code}${text}${ANSI.reset}` : text;
}
function formatTimestamp(now) {
    return now.toISOString().replace("T", " ").replace("Z", "");
}
function shouldUseColor(stream) {
    const preference = process.env.APVISO_COLOR?.toLowerCase();
    if (preference === "always" || preference === "true" || preference === "1")
        return true;
    if (preference === "never" || preference === "false" || preference === "0")
        return false;
    if ("NO_COLOR" in process.env || process.env.APVISO_NO_COLOR)
        return false;
    if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0")
        return true;
    return Boolean(stream.isTTY) && process.env.TERM !== "dumb";
}
export function formatLogLine(level, message, meta, now = new Date(), options = {}) {
    const useColor = options.color ?? false;
    const fields = meta === undefined ? [] : formatMetaFields(meta);
    const levelText = level.toUpperCase().padEnd(5);
    const header = [
        color(formatTimestamp(now), ANSI.dim, useColor),
        color(levelText, LEVEL_COLORS[level], useColor),
        color(redact(message), ANSI.bold, useColor),
    ].join(" ");
    if (fields.length === 0)
        return header;
    const labelWidth = Math.min(24, Math.max(...fields.map(([key]) => key.length)));
    const detailLines = fields.map(([key, value]) => {
        const label = key.padEnd(labelWidth);
        return `  ${color(label, ANSI.dim, useColor)} ${value}`;
    });
    return [
        header,
        ...detailLines,
    ].join("\n");
}
export function log(level, message, meta) {
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    const output = formatLogLine(level, message, meta, new Date(), { color: shouldUseColor(stream) });
    stream.write(`${output}\n`);
}
