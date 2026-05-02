import { arch, platform } from "node:os";
import { RunnerApi } from "./api.js";
import { log } from "./log.js";
import { containerTargetScanUrl, pullAndVerifyImage, runScanContainer } from "./docker.js";
import { runPreflight } from "./preflight.js";
import { RUNNER_VERSION } from "./config.js";
import { providerState } from "./providers.js";
export class RunnerDaemon {
    config;
    api;
    active = new Map();
    shutdownController = new AbortController();
    shuttingDown = false;
    signalCount = 0;
    constructor(config) {
        this.config = config;
        if (!config.token)
            throw new Error("APVISO_RUNNER_TOKEN is required. Run `apviso onboard` or `apviso register` first.");
        this.api = new RunnerApi(config);
    }
    async heartbeat(signal) {
        await this.api.heartbeat({
            version: RUNNER_VERSION,
            os: platform(),
            arch: arch(),
            containerEngine: "docker",
            configuredConcurrency: this.config.concurrency,
            currentJobs: this.active.size,
            providerState: providerState(this.config.modelProvider, this.config.embeddingProvider, this.config),
            capabilities: {
                targetVisibilities: ["public", "staging_preview", "private_internal", "localhost", "partner_client"],
                imageDigest: true,
                localProviderSecrets: true,
                localTargetAuthConfig: !!this.config.targetAuthConfigFile,
                proxy: !!this.config.proxy,
                customCa: !!this.config.customCaPath,
            },
        }, signal);
    }
    async run() {
        const cleanupSignalHandlers = this.installSignalHandlers();
        let heartbeatTimer = null;
        log("info", "runner daemon starting", {
            apiUrl: this.config.apiUrl,
            runnerName: this.config.runnerName,
            workspaceDir: this.config.workspaceDir,
            concurrency: this.config.concurrency,
            modelProvider: this.config.modelProvider,
            embeddingProvider: this.config.embeddingProvider,
        });
        try {
            try {
                await this.heartbeat(this.shutdownController.signal);
            }
            catch (err) {
                if (!this.isShutdownAbort(err))
                    throw err;
            }
            if (!this.shuttingDown) {
                log("info", "runner daemon running", {
                    status: "waiting for jobs",
                    activeJobs: this.active.size,
                    pollIntervalMs: this.config.pollIntervalMs,
                    heartbeatIntervalMs: this.config.heartbeatIntervalMs,
                });
            }
            if (!this.shuttingDown) {
                heartbeatTimer = setInterval(() => {
                    this.heartbeat(this.shutdownController.signal).catch((err) => {
                        if (!this.isShutdownAbort(err))
                            log("warn", "heartbeat failed", String(err));
                    });
                }, this.config.heartbeatIntervalMs);
            }
            while (!this.shuttingDown) {
                try {
                    while (!this.shuttingDown && this.active.size < this.config.concurrency) {
                        const claim = await this.api.claim(this.shutdownController.signal);
                        if (!claim.job || this.shuttingDown)
                            break;
                        if (this.active.has(claim.job.job.id)) {
                            log("warn", "platform returned an already active job; skipping duplicate claim", { jobId: claim.job.job.id });
                            break;
                        }
                        this.startJob(claim.job).catch((err) => log("error", "job failed outside handler", String(err)));
                    }
                }
                catch (err) {
                    if (!this.isShutdownAbort(err))
                        log("warn", "poll failed", String(err));
                }
                await this.sleep(this.config.pollIntervalMs);
            }
        }
        finally {
            if (heartbeatTimer)
                clearInterval(heartbeatTimer);
            cleanupSignalHandlers();
            log("info", "runner daemon stopped", { activeJobs: this.active.size });
        }
    }
    async startJob(job) {
        const abortController = new AbortController();
        this.active.set(job.job.id, abortController);
        log("info", "claimed job", {
            jobId: job.job.id,
            scanId: job.scan.id,
            target: job.target.displayUrl,
            runtimeTarget: job.target.scanUrl,
            visibility: job.target.visibility,
            imageDigest: job.image.digest,
        });
        let leaseTimer = null;
        try {
            leaseTimer = setInterval(() => {
                this.api.renewLease(job.job.id)
                    .then((lease) => {
                    if (lease.cancelRequestedAt) {
                        log("warn", "cancellation requested by platform", { jobId: job.job.id });
                        abortController.abort();
                    }
                })
                    .catch((err) => log("warn", "lease renewal failed", String(err)));
            }, 30_000);
            const preflight = await runPreflight(this.config, job);
            await this.api.preflight(job.job.id, preflight);
            if (!preflight.ok) {
                await this.api.finish(job.job.id, {
                    status: "failed",
                    errorCode: preflight.errorCode,
                    errorMessage: preflight.errorMessage,
                    runtimeMetadata: { preflight: preflight.checks },
                });
                return;
            }
            const lease = await this.api.renewLease(job.job.id);
            if (lease.cancelRequestedAt) {
                log("warn", "cancellation requested before container start", { jobId: job.job.id });
                await this.api.finish(job.job.id, { status: "cancelled", errorCode: "cancelled", errorMessage: "Cancelled by platform before scan start." });
                return;
            }
            await pullAndVerifyImage(this.config, job, abortController.signal);
            if (abortController.signal.aborted) {
                await this.api.finish(job.job.id, { status: "cancelled", errorCode: "cancelled", errorMessage: "Cancelled by platform during image pull." });
                return;
            }
            await this.api.start(job.job.id, {
                targetVisibility: job.target.visibility,
                targetDisplayUrl: job.target.displayUrl,
                targetScanUrl: containerTargetScanUrl(job.target.scanUrl, job.target.visibility),
                imageDigest: job.image.digest,
                runnerVersion: RUNNER_VERSION,
            });
            const result = await runScanContainer(this.config, job, abortController.signal);
            const cancelled = abortController.signal.aborted;
            await this.api.finish(job.job.id, {
                status: cancelled ? "cancelled" : result.exitCode === 0 ? "completed" : "failed",
                ...(cancelled
                    ? { errorCode: "cancelled", errorMessage: "Cancelled by platform." }
                    : result.exitCode === 0
                        ? {}
                        : { errorCode: "container_exit", errorMessage: `Scan container exited with ${result.exitCode}` }),
                runtimeMetadata: {
                    exitCode: result.exitCode,
                    logsPath: result.logsPath,
                    imageDigest: job.image.digest,
                    runnerVersion: RUNNER_VERSION,
                },
            });
        }
        catch (err) {
            await this.api.finish(job.job.id, {
                status: abortController.signal.aborted ? "cancelled" : "failed",
                errorCode: abortController.signal.aborted ? "cancelled" : "runner_error",
                errorMessage: abortController.signal.aborted ? "Cancelled by platform." : err instanceof Error ? err.message : String(err),
            }).catch(() => { });
            log("error", "job failed", { jobId: job.job.id, error: err instanceof Error ? err.message : String(err) });
        }
        finally {
            if (leaseTimer)
                clearInterval(leaseTimer);
            this.active.delete(job.job.id);
        }
    }
    installSignalHandlers() {
        const handleSigterm = () => { this.requestShutdown("SIGTERM"); };
        const handleSigint = () => { this.requestShutdown("SIGINT"); };
        process.on("SIGTERM", handleSigterm);
        process.on("SIGINT", handleSigint);
        return () => {
            process.removeListener("SIGTERM", handleSigterm);
            process.removeListener("SIGINT", handleSigint);
        };
    }
    requestShutdown(signal) {
        this.signalCount += 1;
        this.shuttingDown = true;
        if (!this.shutdownController.signal.aborted)
            this.shutdownController.abort();
        if (this.signalCount === 1) {
            log("info", "shutdown requested", {
                signal,
                activeJobs: this.active.size,
                action: this.active.size > 0 ? "stopping poll loop; press Ctrl-C again to abort active jobs" : "stopping poll loop",
            });
            return;
        }
        for (const controller of this.active.values())
            controller.abort();
        log("warn", "force shutdown requested", {
            signal,
            activeJobs: this.active.size,
            action: "aborting active jobs",
        });
    }
    sleep(ms) {
        return new Promise((resolve) => {
            if (this.shutdownController.signal.aborted) {
                resolve();
                return;
            }
            const timeout = setTimeout(done, ms);
            const signal = this.shutdownController.signal;
            function done() {
                clearTimeout(timeout);
                signal.removeEventListener("abort", done);
                resolve();
            }
            signal.addEventListener("abort", done, { once: true });
        });
    }
    isShutdownAbort(err) {
        return this.shuttingDown &&
            typeof err === "object" &&
            err !== null &&
            "name" in err &&
            err.name === "AbortError";
    }
}
