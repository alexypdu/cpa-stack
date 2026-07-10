# CPA Stack

This directory runs CLIProxyAPI (CPA) and CPA Usage Keeper together with Docker Compose on Colima.

## Architecture

Homebrew starts Colima, Colima provides the Docker engine, and Docker Compose runs the two app containers.

```text
brew services
└── colima
    └── docker compose
        ├── cli-proxy-api
        └── cpa-usage-keeper
```

The old Homebrew-managed `cliproxyapi` service should stay stopped/uninstalled so it does not conflict with Docker CPA on port `8317`.

## Files

```text
/Users/alexdu/repos/cpa-stack/
├── .gitignore
├── README.md
├── docker-compose.yml
├── cpa/
│   ├── config.yaml.default
│   ├── config.yaml
│   ├── auths/
│   └── logs/
└── keeper/
```

Important paths:

```text
cpa/config.yaml.default  Trackable CPA config template
cpa/config.yaml          Local CPA config mounted into Docker CPA; ignored by Git
cpa/auths/               Local CPA auth files mounted into the CPA container; ignored by Git
cpa/logs/                CPA logs; ignored by Git
keeper/                  CPA Usage Keeper SQLite data, logs, and backups; runtime data ignored by Git
```

`cpa/config.yaml` contains API keys and management secrets. Keep it local and use `cpa/config.yaml.default` as the clean template for future migrations.

The original Homebrew CPA files were left separate:

```text
/opt/homebrew/etc/cliproxyapi.conf
/Users/alexdu/.cli-proxy-api
```

## URLs

```text
CPA:    http://127.0.0.1:8317
Keeper: http://127.0.0.1:8318
```

Keeper listens on `8080` inside the container, but Docker publishes it on host port `8318`.

## Secrets

Secrets are not stored in `docker-compose.yml`. Compose reads these exported environment variables from the shell when containers are created:

```sh
CPA_MANAGEMENT_KEY
CPA_KEEPER_LOGIN_PASSWORD
```

These should be exported by your sourced shell secret file, which is sourced from `~/.zshrc`.

`CPA_MANAGEMENT_KEY` is used by Keeper to call CPA management APIs.

`CPA_KEEPER_LOGIN_PASSWORD` is used by you to log into the Keeper dashboard at `http://127.0.0.1:8318`.

In a new normal terminal window, `.zshrc` should already be loaded. To verify without printing secret values:

```sh
printenv CPA_MANAGEMENT_KEY >/dev/null && echo "CPA_MANAGEMENT_KEY set"
printenv CPA_KEEPER_LOGIN_PASSWORD >/dev/null && echo "CPA_KEEPER_LOGIN_PASSWORD set"
```

If running commands from a non-interactive shell, explicitly source `.zshrc` first:

```sh
source ~/.zshrc && docker compose ps
```

## First-Time Setup

Create the local runtime files and directories before starting from a fresh checkout:

```sh
cp cpa/config.yaml.default cpa/config.yaml
mkdir -p cpa/auths cpa/logs keeper
```

Edit `cpa/config.yaml` with local secrets and Docker-specific values:

```yaml
host: ""
auth-dir: "/root/.cli-proxy-api"
usage-statistics-enabled: true

remote-management:
  allow-remote: true
  secret-key: "your-management-key-or-hash"
```

Also replace the example `api-keys` with the client keys you want to allow.

Do not commit `cpa/config.yaml`, auth files, logs, Keeper databases, or `.env` files. They are intentionally ignored by `.gitignore`.

## Daily Commands

Run commands from this directory:

```sh
cd /Users/alexdu/repos/cpa-stack
```

Show status:

```sh
docker compose ps
```

Start or apply normal config changes:

```sh
docker compose up -d
```

Follow logs:

```sh
docker compose logs -f
```

Follow one service's logs:

```sh
docker compose logs -f cli-proxy-api
docker compose logs -f cpa-usage-keeper
```

Stop containers without deleting persisted data:

```sh
docker compose down
```

Restart containers:

```sh
docker compose restart
```

Pull newer images and restart:

```sh
docker compose pull
docker compose up -d
```

## Recreating Containers

Containers do not automatically pick up changed shell environment variables. If you change `CPA_MANAGEMENT_KEY` or `CPA_KEEPER_LOGIN_PASSWORD`, recreate Keeper from a shell where the new vars are exported:

```sh
docker compose up -d --force-recreate cpa-usage-keeper
```

For changes that affect both services, recreate both:

```sh
docker compose up -d --force-recreate
```

This recreates containers, not persistent data. Data remains in:

```text
cpa/
keeper/
```

## Auto-Start Behavior

Colima is managed by Homebrew services:

```sh
brew services list
```

Expected state:

```text
colima      started
cliproxyapi none
```

The Compose services use:

```yaml
restart: unless-stopped
```

This means Docker restarts the containers after crashes or Docker/Colima restarts, unless you explicitly stopped them.

Docker's automatic restart does not source `.zshrc`; it uses the environment values already stored in the existing container configuration from the last `docker compose up`.

## CPA Config Notes

The Docker copy of CPA config is:

```text
/Users/alexdu/repos/cpa-stack/cpa/config.yaml
```

Docker-specific settings in that file:

```yaml
host: ""
auth-dir: "/root/.cli-proxy-api"
usage-statistics-enabled: true

remote-management:
  allow-remote: true
```

Why these matter:

```text
host: ""                         Allows Docker port publishing and container-to-container access.
auth-dir: "/root/.cli-proxy-api"  Matches the mounted auth directory inside the container.
usage-statistics-enabled: true     Required by CPA Usage Keeper.
allow-remote: true                 Allows Keeper, in another container, to call CPA management APIs.
```

Do not edit the old Homebrew config expecting Docker CPA to use it. Docker CPA uses the copied config in this stack directory.

## Ports

Current host ports:

```text
8317 -> CPA container port 8317
8318 -> Keeper container port 8080
```

Port `1455` is not published on the host. Keeper currently reads CPA usage from:

```yaml
REDIS_QUEUE_ADDR: cli-proxy-api:8317
```

## Health Checks

Check CPA:

```sh
curl -I http://127.0.0.1:8317
```

Check Keeper:

```sh
curl -I http://127.0.0.1:8318
```

Check Keeper health endpoint:

```sh
curl -I http://127.0.0.1:8318/healthz
```

## Homebrew CPA Cleanup

The old Homebrew CPA should not run at the same time as Docker CPA.

Stop it:

```sh
brew services stop cliproxyapi
```

Uninstall it if you no longer want the Homebrew binary:

```sh
brew uninstall cliproxyapi
```

If a stale service plist remains:

```sh
rm ~/Library/LaunchAgents/homebrew.mxcl.cliproxyapi.plist
```

Consider keeping the old config/auth files as a backup until the Docker stack has been stable for a while.

## Troubleshooting

If `docker compose` cannot see secret variables, open a new terminal or run:

```sh
source ~/.zshrc
```

If a port is already used:

```sh
lsof -nP -iTCP:8317 -sTCP:LISTEN
lsof -nP -iTCP:8318 -sTCP:LISTEN
```

If Keeper cannot connect to CPA, check logs:

```sh
docker compose logs cpa-usage-keeper
docker compose logs cli-proxy-api
```

If Colima is not running:

```sh
brew services start colima
colima status
```

If containers are stopped and should be running:

```sh
docker compose up -d
```
