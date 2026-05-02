# APVISO Runner

This is the public release and issue-tracking repository for APVISO Runner.
The runner source is maintained privately by Apviso; installable runtime
artifacts are published here, on npm, and on GitHub Container Registry.

## Install

```bash
npm install -g @apviso/runner
apviso version
```

The installed binary is `apviso`; `apviso-runner` is also available as a
compatibility alias.

For one-off onboarding without a global install:

```bash
npx @apviso/runner onboard
```

## Requirements

- Node.js 22 or newer.
- Docker Engine access from the runner process.
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

## Run

```bash
apviso doctor
apviso run
```

`APVISO_API_KEY=apvk_...` is used only for onboarding and user-API actions.
The daemon should run with `APVISO_RUNNER_TOKEN=apvr_...`.

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
```

Supported model providers: `anthropic`, `claude-code`, `openai`,
`openai-codex`, `github-copilot`, `cloudflare-ai-gateway`, and `bedrock`.
Supported embedding providers: `local` and `bedrock-cohere`.

## Local Target Auth

Target application credentials are local to the runner host. Put bearer tokens,
cookies, basic auth, API keys, custom headers, or login credentials in a JSON
file and point `APVISO_TARGET_AUTH_CONFIG_FILE` at it.

```json
{
  "targets": {
    "staging.example.com": {
      "type": "cookie",
      "cookieName": "session",
      "cookieValue": "local-only-cookie"
    }
  }
}
```

Do not include APVISO tokens, model-provider keys, target credentials, or other
secrets in public issues.

## Issues

Use GitHub Issues for reproducible runner bugs, install problems, and docs
feedback. For account, billing, or private target-specific support, contact
Apviso support directly.

## License

APVISO Runner is distributed under the APVISO Runner License. See `LICENSE`.
