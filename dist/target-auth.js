import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function expandHome(path) {
    return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
export function defaultTargetAuthPath() {
    return join(homedir(), ".apviso-runner", "target-auth.json");
}
function readJsonFile(path) {
    if (!existsSync(path))
        return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed))
        throw new Error(`${path} must contain a JSON object`);
    return parsed;
}
function isLocalTargetAuth(value) {
    return isRecord(value) && typeof value.type === "string";
}
function normalizeAuths(auth) {
    const auths = Array.isArray(auth) ? auth : [auth];
    if (auths.length === 0)
        throw new Error("At least one target auth entry is required.");
    return auths;
}
function targetAuthsFromValue(value) {
    if (Array.isArray(value))
        return value.filter(isLocalTargetAuth);
    if (isLocalTargetAuth(value))
        return [value];
    if (isRecord(value)) {
        if (Array.isArray(value.auths))
            return value.auths.filter(isLocalTargetAuth);
        if (isLocalTargetAuth(value.auth))
            return [value.auth];
    }
    return [];
}
function serializeTargetAuthValue(auths) {
    return auths.length === 1 ? auths[0] : auths;
}
function serializeTargetEntry(target, auths) {
    const entry = {
        targetId: target.id,
        domain: target.domain,
        displayUrl: target.displayUrl,
        scanUrl: target.scanUrl,
    };
    if (auths.length === 1)
        entry.auth = auths[0];
    else {
        entry.auth = auths[0];
        entry.auths = auths;
    }
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== null));
}
function nextAuths(existing, incoming, mode) {
    if (mode === "replace")
        return incoming;
    return [...targetAuthsFromValue(existing), ...incoming];
}
export function upsertTargetAuthConfig(filePath, target, auth, options = {}) {
    const path = expandHome(filePath);
    const existing = readJsonFile(path);
    const next = "type" in existing
        ? { default: existing, targets: {} }
        : { ...existing };
    const mode = options.mode ?? "replace";
    const incoming = normalizeAuths(auth);
    const targets = next.targets;
    if (Array.isArray(targets)) {
        const index = targets.findIndex((entry) => isRecord(entry) && entry.targetId === target.id);
        const auths = nextAuths(index >= 0 ? targets[index] : undefined, incoming, mode);
        const entry = serializeTargetEntry(target, auths);
        if (index >= 0)
            targets[index] = entry;
        else
            targets.push(entry);
    }
    else {
        const targetMap = isRecord(targets) ? { ...targets } : {};
        const auths = nextAuths(targetMap[target.id], incoming, mode);
        targetMap[target.id] = serializeTargetAuthValue(auths);
        next.targets = targetMap;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}
