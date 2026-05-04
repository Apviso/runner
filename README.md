# APVISO Runner

This is the public release and issue-tracking repository for APVISO Runner.
The runner source is maintained privately by Apviso; installable runtime
artifacts are published here, on npm, and on GitHub Container Registry.

## Install

Install and immediately start the local web console:

```bash
curl -fsSL https://apviso.com/install.sh | bash
```

The installer requires Node.js 22 or newer plus npm. It runs
`npm install -g @apviso/runner`, then launches `apviso`, which opens the local
browser console by default.

To install without starting the console:

```bash
curl -fsSL https://apviso.com/install.sh | APVISO_INSTALL_ONLY=1 bash
```

You can also install with npm directly:

```bash
npm install -g @apviso/runner
apviso version
apviso update
```

The installed binary is `apviso`; `apviso-runner` is also available as a
compatibility alias.

For one-off onboarding without a global install:

```bash
npx @apviso/runner onboard
```

## Requirements

- Node.js 22 or newer.
- [Docker Engine](https://docs.docker.com/engine/install/) access from the
  runner process.
- Egress to the APVISO API URL.
- Network access from the runner host, or from the configured Docker network, to
  the applications it will scan.
- Local model-provider credentials.

## Onboard

Interactive onboarding with an APVISO user API key:

```bash
APVISO_API_URL=https://app.apviso.com \
APVISO_API_KEY=apvk_... \
apviso onboard
```

Manual registration with an enrollment token:

```bash
APVISO_API_URL=https://app.apviso.com \
apviso register --token apve_... --name prod-runner-1
```

Attach an already rotated runner token:

```bash
APVISO_API_URL=https://app.apviso.com \
apviso register --token apvr_... --name prod-runner-1
```

The runner stores local configuration at `~/.apviso-runner/config.json` by
default with `0600` permissions. Set `APVISO_RUNNER_CONFIG` when running as a
service.

## Web Console

```bash
apviso
```

`apviso ui` and `apviso start` do the same thing explicitly.

On first launch without a stored runner token, the console opens onboarding
first. After the runner is registered, the operator dashboard is unlocked.

The local console binds to `127.0.0.1` by default and opens a per-session
bootstrap token URL. The token is exchanged for a same-origin `HttpOnly` cookie
and removed from the browser URL. It can onboard the runner, run doctor checks,
manage a daemon process it launches, create targets, save runner-local target
auth, show redacted logs, and offer an Update button when npm has a newer
runner release.

## Run

```bash
apviso doctor
apviso run
```

`APVISO_API_KEY=apvk_...` is used only for onboarding and user-API actions.
The daemon should run with `APVISO_RUNNER_TOKEN=apvr_...`.

Update the globally installed npm package with:

```bash
apviso update
```

## Docker

```bash
docker pull ghcr.io/apviso/runner:latest
docker run --rm ghcr.io/apviso/runner:latest version
```

Example Compose service:

```yaml
services:
  apviso-runner:
    image: ghcr.io/apviso/runner:latest
    restart: unless-stopped
    volumes:
      - /var/lib/apviso-runner:/var/lib/apviso-runner
      - /etc/apviso/target-auth.json:/etc/apviso/target-auth.json:ro
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      APVISO_API_URL: "https://app.apviso.com"
      APVISO_RUNNER_TOKEN: "${APVISO_RUNNER_TOKEN}"
      APVISO_RUNNER_NAME: "prod-runner-1"
      APVISO_RUNNER_WORKSPACE: "/var/lib/apviso-runner"
      APVISO_TARGET_AUTH_CONFIG_FILE: "/etc/apviso/target-auth.json"
      APVISO_REQUIRE_IMAGE_SIGNATURE: "true"
      APVISO_ALLOW_UNSIGNED_DEV_IMAGES: "false"
      APVISO_MODEL_PROVIDER: "anthropic"
      APVISO_EMBEDDING_PROVIDER: "local"
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
```

Because this container launches sibling scan containers through the host Docker
socket, `APVISO_RUNNER_WORKSPACE` must be a host path that the host Docker
daemon can mount.

## Environment

```bash
APVISO_API_URL=https://app.apviso.com
APVISO_RUNNER_TOKEN=apvr_...
APVISO_RUNNER_NAME=prod-runner-1
APVISO_RUNNER_WORKSPACE=/var/lib/apviso-runner
APVISO_RUNNER_CONCURRENCY=1
APVISO_RUNNER_POLL_INTERVAL_MS=5000
APVISO_RUNNER_HEARTBEAT_INTERVAL_MS=15000
APVISO_MODEL_PROVIDER=anthropic
APVISO_EMBEDDING_PROVIDER=local
APVISO_TARGET_AUTH_CONFIG_FILE=/etc/apviso/target-auth.json
APVISO_REQUIRE_IMAGE_SIGNATURE=true
APVISO_ALLOW_UNSIGNED_DEV_IMAGES=false
APVISO_COSIGN_CERT_IDENTITY_REGEXP='^https://github.com/apviso/.+'
APVISO_COSIGN_CERT_OIDC_ISSUER=https://token.actions.githubusercontent.com
APVISO_CUSTOM_CA_PATH=/etc/apviso/custom-ca.pem
APVISO_API_TIMEOUT_MS=30000
APVISO_SCAN_TIMEOUT_MS=10800000
APVISO_SCAN_PIDS_LIMIT=512
```

Supported model providers: `anthropic`, `claude-code`, `openai`,
`openai-codex`, `github-copilot`, `cloudflare-ai-gateway`, and `bedrock`.
Supported embedding providers: `local` and `bedrock-cohere`.

OpenAI Codex uses the standard Codex login file at `~/.codex/auth.json`.
Run `codex login` on the runner host before selecting `openai-codex`.

Production runners should leave `APVISO_REQUIRE_IMAGE_SIGNATURE=true` and
`APVISO_ALLOW_UNSIGNED_DEV_IMAGES=false`. With the default policy, the runner
pulls the digest-pinned scan image and verifies it with `cosign` before running
it. For custom scan-image signing, set `APVISO_COSIGN_PUBLIC_KEY_FILE`,
`APVISO_COSIGN_PUBLIC_KEY`, or the `APVISO_COSIGN_CERT_*` trust settings. Use
unsigned images only for local development. These are the runner defaults unless
overridden in the environment or saved config.

Job-scoped APVISO callback tokens are mounted into scan containers as read-only
files and exposed via `APVISO_JOB_TOKEN_FILE` and `APVISO_SCAN_TOKEN_FILE`. Set
`APVISO_EXPOSE_JOB_TOKENS_IN_ENV=true` only for compatibility with older scan
images that cannot read the file-based form.

## Local Target Auth

Target application credentials are local to the runner host. Put bearer tokens,
cookies, basic auth, API keys, custom headers, or login credentials in a JSON
file and point `APVISO_TARGET_AUTH_CONFIG_FILE` at it.

A target can use one auth object or an array when scans should try multiple
authenticated contexts for the same target.

```json
{
  "targets": {
    "staging.example.com": [
      {
        "type": "cookie",
        "cookieName": "session",
        "cookieValue": "local-only-cookie"
      },
      {
        "type": "basic",
        "username": "reviewer",
        "password": "local-only-password"
      }
    ]
  }
}
```

Use `apviso add target-auth <target-id-or-url>` to append local auth entries for
an existing target. Repeat `--auth-type` or use `--auth-types bearer,basic` for
multiple auth entries.

Do not include APVISO tokens, model-provider keys, target credentials, or other
secrets in public issues.

## Issues

Use GitHub Issues for reproducible runner bugs, install problems, and docs
feedback. For account, billing, or private target-specific support, contact
Apviso support directly.

## License

APVISO Runner is distributed under the APVISO Runner License. See `LICENSE`.
