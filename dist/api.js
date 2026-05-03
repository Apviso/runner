export class ApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
export class RunnerApi {
    config;
    constructor(config) {
        this.config = config;
    }
    async request(path, init = {}, auth = { runnerToken: this.config.token ?? null }) {
        const headers = {
            "Content-Type": "application/json",
            ...(init.headers ?? {}),
        };
        if (auth.runnerToken)
            headers.Authorization = `Bearer ${auth.runnerToken}`;
        if (auth.apiKey)
            headers["X-API-Key"] = auth.apiKey;
        const res = await fetch(`${this.config.apiUrl}${path}`, {
            ...init,
            headers,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            let message = text || `Request failed: ${res.status}`;
            try {
                const parsed = JSON.parse(text);
                message = String(parsed.error || parsed.message || message);
            }
            catch { }
            throw new ApiError(message, res.status);
        }
        if (res.status === 204)
            return undefined;
        return await res.json();
    }
    apiKeyRequest(path, init = {}) {
        if (!this.config.apiKey)
            throw new Error("APVISO_API_KEY is required. Run `apviso onboard` first.");
        return this.request(path, init, { apiKey: this.config.apiKey });
    }
    platformTargetRequest(apiKeyPath, runnerPath, init = {}) {
        if (this.config.apiKey)
            return this.request(apiKeyPath, init, { apiKey: this.config.apiKey });
        if (this.config.token)
            return this.request(runnerPath, init, { runnerToken: this.config.token });
        throw new Error("APVISO_API_KEY or APVISO_RUNNER_TOKEN is required. Run `apviso onboard` first.");
    }
    register(body) {
        return this.request("/api/runner/register", {
            method: "POST",
            body: JSON.stringify(body),
        }, { runnerToken: null });
    }
    heartbeat(body, signal) {
        return this.request("/api/runner/heartbeat", {
            method: "POST",
            body: JSON.stringify(body),
            signal,
        });
    }
    claim(signal) {
        return this.request("/api/runner/jobs/claim", { method: "POST", signal });
    }
    renewLease(jobId) {
        return this.request(`/api/runner/jobs/${jobId}/lease`, { method: "POST" });
    }
    preflight(jobId, result) {
        return this.request(`/api/runner/jobs/${jobId}/preflight`, {
            method: "POST",
            body: JSON.stringify(result),
        });
    }
    start(jobId, runtimeMetadata) {
        return this.request(`/api/runner/jobs/${jobId}/start`, {
            method: "POST",
            body: JSON.stringify({ runtimeMetadata }),
        });
    }
    finish(jobId, body) {
        return this.request(`/api/runner/jobs/${jobId}/finish`, {
            method: "POST",
            body: JSON.stringify(body),
        });
    }
    createEnrollmentToken(name) {
        return this.apiKeyRequest("/api/v1/runners/enrollment-tokens", {
            method: "POST",
            body: JSON.stringify({ ...(name ? { name } : {}) }),
        });
    }
    listRunners() {
        return this.apiKeyRequest("/api/v1/runners");
    }
    runnerReadiness(targetId, runnerId) {
        const params = new URLSearchParams();
        if (targetId)
            params.set("targetId", targetId);
        if (runnerId)
            params.set("runnerId", runnerId);
        const query = params.size > 0 ? `?${params}` : "";
        return this.apiKeyRequest(`/api/v1/runners/readiness${query}`);
    }
    createTarget(body) {
        return this.apiKeyRequest("/api/v1/targets", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }
    listTargets(page = 1, limit = 100) {
        const params = new URLSearchParams({
            page: String(page),
            limit: String(limit),
        });
        const query = `?${params}`;
        return this.platformTargetRequest(`/api/v1/targets${query}`, `/api/runner/targets${query}`);
    }
    getTarget(targetId) {
        const encodedTargetId = encodeURIComponent(targetId);
        return this.platformTargetRequest(`/api/v1/targets/${encodedTargetId}`, `/api/runner/targets/${encodedTargetId}`);
    }
    scanCallbackUrl(job) {
        return `${this.config.apiUrl}${job.platform.callbackBasePath}`;
    }
}
