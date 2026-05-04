import { cancel, confirm, isCancel, password, select, text, } from "@clack/prompts";
export class PromptCancelledError extends Error {
    constructor() {
        super("Operation cancelled.");
        this.name = "PromptCancelledError";
    }
}
export function isPromptCancelled(err) {
    return err instanceof PromptCancelledError;
}
function cleanQuestion(question) {
    return question.replace(/:\s*$/, "").trim();
}
function unwrapPrompt(value) {
    if (isCancel(value)) {
        cancel("Operation cancelled.");
        throw new PromptCancelledError();
    }
    return value;
}
function promptStringValue(value) {
    const answer = unwrapPrompt(value);
    return typeof answer === "string" ? answer.trim() : "";
}
function humanizeChoice(value) {
    const known = {
        api_key: "API key",
        bedrock: "Bedrock",
        "bedrock-cohere": "Bedrock Cohere",
        bearer: "Bearer token",
        basic: "Basic auth",
        "claude-code": "Claude Code",
        "cloudflare-ai-gateway": "Cloudflare AI Gateway",
        cookie: "Cookie",
        cookies: "Cookie jar",
        custom_headers: "Custom headers",
        browser_state: "Browser storage state",
        "github-copilot": "GitHub Copilot",
        local: "Local",
        localhost: "Localhost",
        login: "Login flow",
        none: "None",
        openai: "OpenAI",
        "openai-codex": "OpenAI Codex",
        partner_client: "Partner client",
        private_internal: "Private internal",
        public: "Public",
        staging_preview: "Staging preview",
    };
    if (known[value])
        return known[value];
    return value
        .split(/[-_]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
export function createPrompter() {
    return {
        ask: async (question) => {
            return promptStringValue(await text({ message: cleanQuestion(question) }));
        },
        confirm: async ({ message, defaultValue }) => unwrapPrompt(await confirm({ message, initialValue: defaultValue })),
        password: async ({ message, currentValue }) => {
            const answer = promptStringValue(await password({
                message: currentValue ? `${message} (leave blank to keep stored value)` : message,
            }));
            return answer || currentValue || "";
        },
        select: async ({ message, options, defaultValue }) => unwrapPrompt(await select({
            message,
            options: options.map((option) => ({
                value: option.value,
                label: option.label ?? humanizeChoice(option.value),
                hint: option.hint,
            })),
            initialValue: defaultValue,
        })),
        text: async ({ message, defaultValue, initialValue, placeholder, validate }) => {
            const answer = promptStringValue(await text({
                message,
                defaultValue,
                initialValue: initialValue ?? defaultValue,
                placeholder,
                validate,
            }));
            return answer || defaultValue || "";
        },
    };
}
export function labelDefault(defaultValue) {
    return defaultValue === undefined || defaultValue === "" ? "" : ` [${defaultValue}]`;
}
export async function promptString(prompter, label, defaultValue) {
    if (prompter.text)
        return prompter.text({ message: label, defaultValue });
    const answer = (await prompter.ask(`${label}${labelDefault(defaultValue)}: `)).trim();
    return answer || defaultValue || "";
}
export async function promptRequired(prompter, label, defaultValue) {
    if (prompter.text) {
        return prompter.text({
            message: label,
            defaultValue,
            validate: (value) => value?.trim() || defaultValue ? undefined : `${label} is required.`,
        });
    }
    while (true) {
        const answer = await promptString(prompter, label, defaultValue);
        if (answer)
            return answer;
        console.log(`${label} is required.`);
    }
}
export async function promptSecret(prompter, label, currentValue) {
    if (prompter.password) {
        const answer = await prompter.password({ message: label, currentValue });
        return answer || currentValue || "";
    }
    const suffix = currentValue ? " [stored, press enter to keep]" : "";
    const answer = (await prompter.ask(`${label}${suffix}: `)).trim();
    return answer || currentValue || "";
}
export async function promptNumber(prompter, label, defaultValue) {
    if (prompter.text) {
        const raw = await prompter.text({
            message: label,
            defaultValue: String(defaultValue),
            validate: (value) => {
                const parsed = Number(value?.trim() || String(defaultValue));
                return Number.isFinite(parsed) && parsed > 0 ? undefined : `${label} must be a positive number.`;
            },
        });
        return Number(raw);
    }
    while (true) {
        const raw = await promptString(prompter, label, String(defaultValue));
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0)
            return value;
        console.log(`${label} must be a positive number.`);
    }
}
export async function promptChoice(prompter, label, choices, defaultValue) {
    if (prompter.select) {
        return prompter.select({
            message: label,
            options: choices.map((choice) => ({
                value: choice,
                hint: choice === defaultValue ? "current" : undefined,
            })),
            defaultValue,
        });
    }
    const choiceList = choices.join("/");
    while (true) {
        const answer = (await promptString(prompter, `${label} (${choiceList})`, defaultValue)).toLowerCase();
        const match = choices.find((choice) => choice.toLowerCase() === answer);
        if (match)
            return match;
        console.log(`${label} must be one of: ${choiceList}.`);
    }
}
export async function promptYesNo(prompter, label, defaultValue = false) {
    if (prompter.confirm)
        return prompter.confirm({ message: label, defaultValue });
    const suffix = defaultValue ? "Y/n" : "y/N";
    while (true) {
        const answer = (await prompter.ask(`${label} (${suffix}): `)).trim().toLowerCase();
        if (!answer)
            return defaultValue;
        if (["y", "yes"].includes(answer))
            return true;
        if (["n", "no"].includes(answer))
            return false;
        console.log("Answer yes or no.");
    }
}
