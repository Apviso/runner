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
export function upsertTargetAuthConfig(filePath, target, auth) {
    const path = expandHome(filePath);
    const existing = readJsonFile(path);
    const next = "type" in existing
        ? { default: existing, targets: {} }
        : { ...existing };
    const targets = next.targets;
    if (Array.isArray(targets)) {
        const index = targets.findIndex((entry) => isRecord(entry) && entry.targetId === target.id);
        const entry = {
            targetId: target.id,
            domain: target.domain,
            displayUrl: target.displayUrl,
            scanUrl: target.scanUrl,
            auth,
        };
        if (index >= 0)
            targets[index] = entry;
        else
            targets.push(entry);
    }
    else {
        const targetMap = isRecord(targets) ? { ...targets } : {};
        targetMap[target.id] = auth;
        next.targets = targetMap;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}
