import { spawn } from "node:child_process";
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
function appendBounded(current, incoming, maxBufferBytes, droppedBytes) {
    if (maxBufferBytes <= 0) {
        return { value: "", droppedBytes: droppedBytes + Buffer.byteLength(incoming) };
    }
    const combined = Buffer.concat([Buffer.from(current), Buffer.from(incoming)]);
    if (combined.length <= maxBufferBytes)
        return { value: combined.toString("utf8"), droppedBytes };
    const dropped = combined.length - maxBufferBytes;
    return {
        value: combined.subarray(dropped).toString("utf8"),
        droppedBytes: droppedBytes + dropped,
    };
}
function withTruncationMarker(value, droppedBytes) {
    return droppedBytes > 0 ? `[truncated ${droppedBytes} bytes]\n${value}` : value;
}
export function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let stdoutDroppedBytes = 0;
        let stderrDroppedBytes = 0;
        const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
        let timeout = null;
        const cleanup = () => {
            if (timeout)
                clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
        };
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            child.kill("SIGKILL");
            reject(err instanceof Error ? err : new Error(String(err)));
        };
        const abort = () => {
            child.kill("SIGKILL");
            finish({
                code: 130,
                stdout: withTruncationMarker(stdout, stdoutDroppedBytes),
                stderr: `${withTruncationMarker(stderr, stderrDroppedBytes)}\ncommand aborted`,
            });
        };
        timeout = options.timeoutMs
            ? setTimeout(() => {
                child.kill("SIGKILL");
                finish({
                    code: 124,
                    stdout: withTruncationMarker(stdout, stdoutDroppedBytes),
                    stderr: `${withTruncationMarker(stderr, stderrDroppedBytes)}\ncommand timed out`,
                });
            }, options.timeoutMs)
            : null;
        if (options.signal?.aborted)
            abort();
        else
            options.signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk) => {
            const text = String(chunk);
            const next = appendBounded(stdout, text, maxBufferBytes, stdoutDroppedBytes);
            stdout = next.value;
            stdoutDroppedBytes = next.droppedBytes;
            try {
                options.onStdout?.(text);
            }
            catch (err) {
                fail(err);
            }
        });
        child.stderr.on("data", (chunk) => {
            const text = String(chunk);
            const next = appendBounded(stderr, text, maxBufferBytes, stderrDroppedBytes);
            stderr = next.value;
            stderrDroppedBytes = next.droppedBytes;
            try {
                options.onStderr?.(text);
            }
            catch (err) {
                fail(err);
            }
        });
        child.on("error", fail);
        child.on("close", (code) => {
            finish({
                code,
                stdout: withTruncationMarker(stdout, stdoutDroppedBytes),
                stderr: withTruncationMarker(stderr, stderrDroppedBytes),
            });
        });
    });
}
