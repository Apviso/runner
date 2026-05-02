import { intro, log as clackLog, note, outro, spinner } from "@clack/prompts";
import { RUNNER_VERSION } from "./config.js";
import { redact } from "./log.js";
function messageFor(message, result) {
    return typeof message === "function" ? message(result) : message;
}
export function startScreen(title) {
    intro(`APVISO Runner ${RUNNER_VERSION} - ${title}`);
}
export function endScreen(message) {
    outro(message);
}
export function info(message) {
    clackLog.info(redact(message));
}
export function success(message) {
    clackLog.success(redact(message));
}
export function warning(message) {
    clackLog.warn(redact(message));
}
export function failure(message) {
    clackLog.error(redact(message));
}
export function step(message) {
    clackLog.step(redact(message));
}
export function message(message) {
    const value = Array.isArray(message) ? message.map((line) => redact(line)) : redact(message);
    clackLog.message(value);
}
export function panel(title, body) {
    note(redact(body), title);
}
export async function withSpinner(pendingMessage, task, doneMessage) {
    const pending = spinner();
    pending.start(pendingMessage);
    try {
        const result = await task();
        pending.stop(messageFor(doneMessage, result));
        return result;
    }
    catch (err) {
        pending.error("Command failed.");
        throw err;
    }
}
