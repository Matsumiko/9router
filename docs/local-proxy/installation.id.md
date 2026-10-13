# Instalasi Local Proxy

## Syarat

- Node.js 20 atau lebih baru untuk menjalankan source.
- Executable yang kompatibel dengan sing-box di mesin yang sama dengan 9Router.
- Permission write ke data directory 9Router.
- Akses HTTP(S) publik ke URL health check yang dipilih.

9Router tidak membundel proxy core. 9Router menerima binary resmi `sing-box` dan build `nekobox_core` yang kompatibel. Core resmi direkomendasikan karena merupakan upstream utama; kedua binary tetap perlu divalidasi dengan format node yang benar-benar digunakan.

## Instalasi sing-box resmi

### Debian atau Ubuntu

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

Jika `config-manager` belum tersedia, instal `dnf-plugins-core` terlebih dahulu.

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
# atau: scoop install sing-box
# atau: choco install sing-box
```

### Instalasi manual Linux

```bash
curl -fsSL https://sing-box.app/install.sh | sh
```

Tinjau script remote sesuai policy supply-chain. Gunakan versi pinned jika diperlukan:

```bash
curl -fsSL https://sing-box.app/install.sh | sh -s -- --version <version>
```

Referensi resmi: <https://sing-box.sagernet.org/installation/package-manager/>.

## Memilih executable

Urutan pencarian 9Router:

1. `SING_BOX_BIN`, jika diset dan executable;
2. `SINGBOX_BIN`, jika diset dan executable;
3. `sing-box` dan `nekobox_core` di setiap directory pada `PATH` proses;
4. `$HOME/.local/bin/sing-box` dan `$HOME/.local/bin/nekobox_core`;
5. padanan di `/usr/local/bin`, `/usr/bin`, dan `/bin`.

Gunakan absolute path jika service manager memiliki `PATH` berbeda:

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

Variable harus ada di environment proses 9Router. Mengaturnya di terminal lain tidak cukup untuk systemd, Docker, atau supervisor lain.

## Validasi sebelum menjalankan 9Router

```bash
$SING_BOX_BIN version
$SING_BOX_BIN check -c /path/to/generated/sing-box.json
```

File generated baru ada setelah Local Proxy membuat node/config. Gunakan **Preview config** di dashboard terlebih dahulu, atau validasi `<DATA_DIR>/local-proxy/sing-box.json`.

## Instalasi dan menjalankan repository ini

```bash
git clone https://github.com/Matsumiko/9router.git
cd 9router
cp .env.example .env
npm install
export SING_BOX_BIN=/absolute/path/to/sing-box
npm run build
PORT=20128 HOSTNAME=127.0.0.1 NEXT_PUBLIC_BASE_URL=http://127.0.0.1:20128 npm run start
```

Buka `/dashboard/local-proxy`. Package npm upstream adalah distribusi terpisah dan bisa tidak berisi implementasi Local Proxy yang sudah dimodifikasi ini.

## Path runtime

- Config utama: `<DATA_DIR>/local-proxy/sing-box.json`.
- PID file: `<DATA_DIR>/local-proxy/sing-box.pid`.
- Config health sementara: `<DATA_DIR>/local-proxy/health-<node-id>.json`, dihapus setelah probe.
- Listener utama: `127.0.0.1:20129`, atau `NINE_ROUTER_LOCAL_PROXY_PORT`.
- Controller Clash API: `127.0.0.1:20130`, atau `NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT`.
