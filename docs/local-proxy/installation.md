# Local Proxy installation

## Requirements

- Node.js 20 or newer for source execution.
- A sing-box-compatible executable on the same machine as 9Router.
- Write access to the 9Router data directory.
- Public HTTP(S) reachability for the configured health URL.

9Router does not bundle a proxy core. It accepts the official `sing-box` binary and compatible `nekobox_core` builds. The official core is the default recommendation because it is the upstream project; both binaries must still be validated against the actual node formats you use.

## Install official sing-box

Use the package source appropriate for the host. Examples:

### Debian or Ubuntu

```bash
sudo mkdir -p /etc/apt/keyrings
sudo curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
sudo chmod a+r /etc/apt/keyrings/sagernet.asc
printf '%s\n' 'Types: deb' 'URIs: https://deb.sagernet.org/' 'Suites: *' 'Components: *' 'Enabled: yes' 'Signed-By: /etc/apt/keyrings/sagernet.asc' | sudo tee /etc/apt/sources.list.d/sagernet.sources
sudo apt-get update
sudo apt-get install sing-box
```

### Fedora/RHEL

```bash
sudo dnf config-manager --add-repo https://sing-box.app/sing-box.repo
sudo dnf install sing-box
```

Install `dnf-plugins-core` first if `config-manager` is unavailable.

### Arch

```bash
paru -S sing-box
```

### Homebrew

```bash
brew install sing-box
```

### Windows

```powershell
winget install SagerNet.sing-box
# or: scoop install sing-box
# or: choco install sing-box
```

### Manual Linux installation

```bash
curl -fsSL https://sing-box.app/install.sh | sh
```

Review remote installation scripts according to your supply-chain policy. Pin a release when required:

```bash
curl -fsSL https://sing-box.app/install.sh | sh -s -- --version <version>
```

Official reference: <https://sing-box.sagernet.org/installation/package-manager/>.

## Select the executable

9Router resolves the executable in this order:

1. `SING_BOX_BIN`, if set and executable;
2. `SINGBOX_BIN`, if set and executable;
3. `sing-box` and `nekobox_core` in each directory in the process `PATH`;
4. `$HOME/.local/bin/sing-box` and `$HOME/.local/bin/nekobox_core`;
5. `/usr/local/bin`, `/usr/bin`, and `/bin` equivalents.

Set an absolute path when a service manager has a different `PATH`:

```bash
export SING_BOX_BIN=/usr/local/bin/sing-box
sing-box version
sing-box check --help
```

PowerShell:

```powershell
$env:SING_BOX_BIN = 'C:\Program Files\sing-box\sing-box.exe'
& $env:SING_BOX_BIN version
```

The variable must be present in the environment of the 9Router process. Setting it in an unrelated interactive shell is insufficient for systemd, Docker, or another supervisor.

## Verify before starting 9Router

```bash
$SING_BOX_BIN version
$SING_BOX_BIN check -c /path/to/generated/sing-box.json
```

The generated file exists only after Local Proxy has created a node/config. Use the dashboard **Preview config** first, or validate the file at `<DATA_DIR>/local-proxy/sing-box.json`.

## Install and run this repository

```bash
git clone https://github.com/Matsumiko/9router.git
cd 9router
cp .env.example .env
npm install
export SING_BOX_BIN=/absolute/path/to/sing-box
npm run build
PORT=20128 HOSTNAME=127.0.0.1 NEXT_PUBLIC_BASE_URL=http://127.0.0.1:20128 npm run start
```

Open `/dashboard/local-proxy`. The published upstream npm package is a separate distribution and may not contain this modified Local Proxy implementation.

## Runtime paths

- Main config: `<DATA_DIR>/local-proxy/sing-box.json`.
- PID file: `<DATA_DIR>/local-proxy/sing-box.pid`.
- Temporary health configs: `<DATA_DIR>/local-proxy/health-<node-id>.json`, removed after the probe.
- Main listener: `127.0.0.1:20129`, or `NINE_ROUTER_LOCAL_PROXY_PORT`.
- Clash API controller: `127.0.0.1:20130`, or `NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT`.
