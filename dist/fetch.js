import { readFileSync } from "node:fs";
import { Agent } from "undici";
const caDispatchers = new Map();
function customCaDispatcher(path) {
    if (!path)
        return undefined;
    const existing = caDispatchers.get(path);
    if (existing)
        return existing;
    const ca = readFileSync(path, "utf8");
    const dispatcher = new Agent({ connect: { ca } });
    caDispatchers.set(path, dispatcher);
    return dispatcher;
}
function signalWithTimeout(signal, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return signal ?? new AbortController().signal;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!signal)
        return timeoutSignal;
    if (signal.aborted)
        return signal;
    return AbortSignal.any([signal, timeoutSignal]);
}
export async function runnerFetch(config, input, init = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? Number(process.env.APVISO_API_TIMEOUT_MS || 30_000);
    const dispatcher = customCaDispatcher(config.customCaPath);
    const nextInit = {
        ...init,
        signal: signalWithTimeout(init.signal, timeoutMs),
    };
    if (dispatcher)
        nextInit.dispatcher = dispatcher;
    return fetch(input, nextInit);
}
