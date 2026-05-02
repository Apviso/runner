import { spawn } from "node:child_process";
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
        let timeout = null;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (timeout)
                clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            resolve(result);
        };
        const abort = () => {
            child.kill("SIGKILL");
            finish({ code: 130, stdout, stderr: `${stderr}\ncommand aborted` });
        };
        timeout = options.timeoutMs
            ? setTimeout(() => {
                child.kill("SIGKILL");
                finish({ code: 124, stdout, stderr: `${stderr}\ncommand timed out` });
            }, options.timeoutMs)
            : null;
        if (options.signal?.aborted)
            abort();
        else
            options.signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (err) => {
            if (settled)
                return;
            if (timeout)
                clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            reject(err);
        });
        child.on("close", (code) => {
            finish({ code, stdout, stderr });
        });
    });
}
