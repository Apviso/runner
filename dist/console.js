import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig, RUNNER_VERSION } from "./config.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { redact } from "./log.js";
import { createTarget, embeddingCredentialNames, providerCredentialNames, safeRunnerConfig, saveRunnerConfig, setupOptions, onboardRunner, } from "./setup.js";
import * as ui from "./ui.js";
const MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};
export class ConsoleEventHub {
    clients = new Set();
    connect(req, res) {
        res.writeHead(200, {
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Content-Type": "text/event-stream; charset=utf-8",
            "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        this.clients.add(res);
        req.on("close", () => {
            this.clients.delete(res);
            res.end();
        });
    }
    emit(type, data) {
        const event = { type, data, at: new Date().toISOString() };
        const payload = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
        for (const client of this.clients)
            client.write(payload);
    }
}
export class DaemonManager {
    events;
    options;
    child;
    stopping = false;
    logBuffer = [];
    stateValue = {
        status: "stopped",
        activeJobCount: 0,
        recentJobs: [],
    };
    constructor(events = new ConsoleEventHub(), options = {}) {
        this.events = events;
        this.options = options;
    }
    state() {
        return {
            ...this.stateValue,
            recentJobs: [...this.stateValue.recentJobs],
            lastExit: this.stateValue.lastExit ? { ...this.stateValue.lastExit } : undefined,
        };
    }
    logs(limit = 250) {
        return this.logBuffer.slice(-limit);
    }
    async start() {
        if (this.child && ["starting", "running", "stopping"].includes(this.stateValue.status)) {
            throw new Error("Runner daemon is already managed by this console.");
        }
        const config = loadConfig();
        if (!config.token)
            throw new Error("APVISO_RUNNER_TOKEN is required. Run onboarding before starting the daemon.");
        this.stopping = false;
        this.updateState({
            status: "starting",
            activeJobCount: 0,
            recentJobs: this.stateValue.recentJobs,
            lastError: undefined,
            lastExit: undefined,
            stoppedAt: undefined,
        });
        const cliPath = this.options.cliPath || fileURLToPath(new URL("./cli.js", import.meta.url));
        const nodePath = this.options.nodePath || process.execPath;
        const spawnRunner = this.options.spawn || ((command, args, options) => spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }));
        const child = spawnRunner(nodePath, [cliPath, "run"], {
            cwd: process.cwd(),
            env: { ...process.env, APVISO_COLOR: "never" },
        });
        this.child = child;
        this.updateState({
            status: "running",
            pid: child.pid,
            startedAt: new Date().toISOString(),
            stoppedAt: undefined,
        });
        child.stdout?.on("data", (chunk) => this.handleLog("stdout", chunk));
        child.stderr?.on("data", (chunk) => this.handleLog("stderr", chunk));
        child.once("error", (err) => {
            this.handleProcessError(err);
        });
        child.once("close", (code, signal) => {
            this.handleProcessClose(code, signal);
        });
        return this.state();
    }
    async stop() {
        if (!this.child || this.stateValue.status === "stopped" || this.stateValue.status === "crashed") {
            this.updateState({ status: "stopped", stoppedAt: new Date().toISOString() });
            return this.state();
        }
        this.stopping = true;
        this.updateState({ status: "stopping" });
        const child = this.child;
        await new Promise((resolveStop) => {
            const timeout = setTimeout(() => {
                child.kill("SIGKILL");
                resolveStop();
            }, 10_000);
            child.once("close", () => {
                clearTimeout(timeout);
                resolveStop();
            });
            child.kill("SIGINT");
        });
        return this.state();
    }
    async restart() {
        await this.stop();
        return this.start();
    }
    updateState(update) {
        this.stateValue = { ...this.stateValue, ...update };
        this.events.emit("state", this.state());
    }
    handleLog(stream, chunk) {
        const at = new Date().toISOString();
        const lines = String(chunk)
            .split(/\r?\n/)
            .map((line) => redact(line).trimEnd())
            .filter(Boolean);
        for (const line of lines) {
            this.logBuffer.push({ stream, line, at });
            if (this.logBuffer.length > 1_000)
                this.logBuffer.shift();
            this.observeLogLine(line, at);
            this.events.emit("log", { stream, line, at });
        }
    }
    observeLogLine(line, at) {
        if (line.includes("runner daemon running"))
            this.updateState({ lastHeartbeatAt: at });
        if (line.includes("claimed job")) {
            this.updateState({
                activeJobCount: this.stateValue.activeJobCount + 1,
                recentJobs: [`Claimed job at ${at}`, ...this.stateValue.recentJobs].slice(0, 8),
            });
        }
        if (line.includes("job failed") || line.includes("container exited") || line.includes("runner daemon stopped")) {
            this.updateState({ activeJobCount: Math.max(0, this.stateValue.activeJobCount - 1) });
        }
        if (line.includes(" failed") || line.includes("ERROR")) {
            this.updateState({ lastError: line });
        }
    }
    handleProcessError(err) {
        this.updateState({
            status: "crashed",
            lastError: redact(err.message),
            stoppedAt: new Date().toISOString(),
        });
    }
    handleProcessClose(code, signal) {
        const status = this.stopping || code === 0 ? "stopped" : "crashed";
        this.child = undefined;
        this.stopping = false;
        this.updateState({
            status,
            pid: undefined,
            stoppedAt: new Date().toISOString(),
            lastExit: { code, signal },
            activeJobCount: 0,
            lastError: status === "crashed" ? `Runner daemon exited with ${code ?? signal ?? "unknown status"}` : this.stateValue.lastError,
        });
    }
}
export async function startConsoleServer(options = {}) {
    const host = options.host || "127.0.0.1";
    const port = options.port ?? 0;
    const token = options.token || randomBytes(24).toString("base64url");
    const events = new ConsoleEventHub();
    const daemon = options.daemonManager || new DaemonManager(events);
    const webRoot = resolveWebRoot(options.webRoot);
    let lastDoctor = null;
    const server = createServer(async (req, res) => {
        try {
            const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
            if (requestUrl.pathname.startsWith("/api/") && !isAuthorized(req, requestUrl, token)) {
                sendJson(res, 401, { error: "Unauthorized" });
                return;
            }
            if (req.method === "GET" && requestUrl.pathname === "/api/events") {
                events.connect(req, res);
                events.emit("state", buildState(daemon, lastDoctor));
                return;
            }
            if (req.method === "GET" && requestUrl.pathname === "/api/state") {
                sendJson(res, 200, buildState(daemon, lastDoctor));
                return;
            }
            if (req.method === "POST" && requestUrl.pathname === "/api/onboard") {
                const body = await readJson(req);
                const result = await onboardRunner(body);
                lastDoctor = result.doctor;
                events.emit("doctor", result.doctor);
                events.emit("config", safeRunnerConfig(result.config));
                sendJson(res, 200, {
                    mode: result.mode,
                    doctor: result.doctor,
                    config: safeRunnerConfig(result.config),
                });
                return;
            }
            if (req.method === "POST" && requestUrl.pathname === "/api/config") {
                const body = await readJson(req);
                const config = saveRunnerConfig(body);
                events.emit("config", safeRunnerConfig(config));
                sendJson(res, 200, { config: safeRunnerConfig(config) });
                return;
            }
            if (req.method === "POST" && requestUrl.pathname === "/api/doctor") {
                lastDoctor = await runDoctor(loadConfig());
                events.emit("doctor", lastDoctor);
                sendJson(res, 200, { doctor: lastDoctor, formatted: formatDoctor(lastDoctor) });
                return;
            }
            if (req.method === "POST" && requestUrl.pathname === "/api/daemon/start") {
                sendJson(res, 200, { daemon: await daemon.start() });
                return;
            }
            if (req.method === "POST" && requestUrl.pathname === "/api/daemon/stop") {
                sendJson(res, 200, { daemon: await daemon.stop() });
                return;
            }
            if (req.method === "POST" && requestUrl.pathname === "/api/daemon/restart") {
                sendJson(res, 200, { daemon: await daemon.restart() });
                return;
            }
            if (req.method === "POST" && requestUrl.pathname === "/api/targets") {
                const body = await readJson(req);
                const result = await createTarget({
                    target: String(body.target || ""),
                    visibility: String(body.visibility || "public"),
                    scanUrl: typeof body.scanUrl === "string" ? body.scanUrl : undefined,
                    partnerClientId: typeof body.partnerClientId === "string" ? body.partnerClientId : undefined,
                    auth: body.auth,
                    targetAuthFile: typeof body.targetAuthFile === "string" ? body.targetAuthFile : undefined,
                    authMode: "append",
                });
                events.emit("target", { target: result.target, authFile: result.authFile });
                sendJson(res, 200, { target: result.target, authFile: result.authFile });
                return;
            }
            if (req.method === "GET" && requestUrl.pathname === "/api/logs") {
                const jobId = requestUrl.searchParams.get("jobId");
                if (jobId) {
                    sendJson(res, 200, { logs: readJobLog(loadConfig().workspaceDir, jobId) });
                }
                else {
                    sendJson(res, 200, { logs: daemon.logs() });
                }
                return;
            }
            await serveWebAsset(webRoot, requestUrl.pathname, res);
        }
        catch (err) {
            sendJson(res, 500, { error: redact(err instanceof Error ? err.message : String(err)) });
        }
    });
    await new Promise((resolveListen) => {
        server.listen(port, host, resolveListen);
    });
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const url = `http://${host}:${actualPort}/?token=${encodeURIComponent(token)}`;
    return {
        server,
        url,
        token,
        daemon,
        close: () => new Promise((resolveClose, rejectClose) => {
            server.close((err) => {
                if (err)
                    rejectClose(err);
                else
                    resolveClose();
            });
        }),
    };
}
export async function startConsoleCommand(options) {
    const consoleServer = await startConsoleServer(options);
    ui.startScreen("Web Console");
    ui.info(`Local console: ${consoleServer.url}`);
    ui.info(`Host ${hostname()} is serving the console on ${options.host}.`);
    if (options.open)
        openBrowser(consoleServer.url);
    await new Promise((resolveShutdown) => {
        const shutdown = () => {
            consoleServer.daemon.stop()
                .catch(() => undefined)
                .finally(() => consoleServer.close().finally(resolveShutdown));
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    });
    ui.endScreen("Web console stopped.");
    return 0;
}
function buildState(daemon, doctor) {
    const config = loadConfig();
    return {
        version: RUNNER_VERSION,
        configPath: configPath(),
        config: safeRunnerConfig(config),
        daemon: daemon.state(),
        doctor,
        externalService: detectExternalService(),
        options: {
            ...setupOptions,
            providerCredentials: Object.fromEntries(setupOptions.modelProviders.map((provider) => [provider, providerCredentialNames(provider)])),
            embeddingCredentials: Object.fromEntries(setupOptions.embeddingProviders.map((provider) => [provider, embeddingCredentialNames(provider)])),
        },
    };
}
function isAuthorized(req, requestUrl, token) {
    const header = req.headers["x-apviso-console-token"];
    const headerToken = Array.isArray(header) ? header[0] : header;
    const authorization = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    return headerToken === token || authorization === token || requestUrl.searchParams.get("token") === token;
}
async function readJson(req) {
    let raw = "";
    for await (const chunk of req) {
        raw += String(chunk);
        if (raw.length > 1024 * 1024)
            throw new Error("Request body is too large.");
    }
    return (raw ? JSON.parse(raw) : {});
}
function sendJson(res, status, body) {
    res.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(body, null, 2));
}
async function serveWebAsset(webRoot, pathname, res) {
    if (!webRoot) {
        res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>APVISO Runner</title><p>Web assets are not built. Run bun run build.</p>");
        return;
    }
    const decodedPath = decodeURIComponent(pathname);
    const candidate = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    const filePath = normalize(resolve(webRoot, candidate));
    const safeRoot = normalize(webRoot.endsWith(sep) ? webRoot : `${webRoot}${sep}`);
    const indexPath = join(webRoot, "index.html");
    const resolved = filePath.startsWith(safeRoot) && existsSync(filePath) && statSync(filePath).isFile()
        ? filePath
        : indexPath;
    if (!existsSync(resolved)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
    }
    res.writeHead(200, {
        "Cache-Control": resolved.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
        "Content-Type": MIME_TYPES[extname(resolved)] || "application/octet-stream",
    });
    createReadStream(resolved).pipe(res);
}
function resolveWebRoot(webRoot) {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        webRoot,
        join(currentDir, "web"),
        join(process.cwd(), "dist", "web"),
    ].filter((value) => !!value);
    return candidates.find((candidate) => existsSync(join(candidate, "index.html")));
}
function detectExternalService() {
    const systemdUnits = [
        "/etc/systemd/system/apviso-runner.service",
        "/lib/systemd/system/apviso-runner.service",
        "/usr/lib/systemd/system/apviso-runner.service",
    ].filter(existsSync);
    const composeCandidates = [
        join(process.cwd(), "compose.yml"),
        join(process.cwd(), "compose.yaml"),
        join(process.cwd(), "docker-compose.yml"),
        join(process.cwd(), "docker-compose.yaml"),
    ].filter(existsSync);
    return { systemdUnits, dockerComposeFiles: composeCandidates };
}
function readJobLog(workspaceDir, jobId) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(jobId))
        throw new Error("Invalid job ID.");
    const logPath = resolve(workspaceDir, jobId, "container.log");
    const safeWorkspace = normalize(resolve(workspaceDir) + sep);
    if (!normalize(logPath).startsWith(safeWorkspace))
        throw new Error("Invalid job log path.");
    if (!existsSync(logPath))
        return "";
    const lines = readFileSync(logPath, "utf8").split(/\r?\n/).slice(-500);
    return redact(lines.join("\n"));
}
function openBrowser(url) {
    const command = platform() === "darwin"
        ? "open"
        : platform() === "win32"
            ? "cmd"
            : "xdg-open";
    const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => { });
    child.unref();
}
