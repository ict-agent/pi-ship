# pi-ship 迁移指南

把一台机器上的 pi 环境（扩展包 + 自定义 provider + 用户配置）完整复刻到另一台机器。

**不打包 pi 二进制**（平台相关），runbook 会在目标机自行安装。

---

## 0. 你会得到什么

一个 bundle 目录：

```
pi-migrate-<host>-<date>/
├── install.sh          ← 主脚本：自检 + 交互配置 + 自动安装
├── pi-ship.json        ← 清单：每一层、每个版本
├── .env.example        ← 需要哪些密钥（只有名字）
├── .secrets.env        ← 密钥值（仅当用 --with-keys 导出；权限 600）
├── .pi-ship.conf       ← 交互答案存档（脚本生成）
├── .gitignore          ← 已排除 .env / .secrets.env
├── config/             ← provider 定义 + 配置文件 + settings
├── extensions/         ← 散装扩展源码
├── bin/                ← 两个零依赖 merge 脚本
└── README.md           ← 本 bundle 的摘要
```

分层：**扩展包（默认）** / 散装扩展（默认） / provider（`--providers`） / 配置文件（`--config`） / 密钥值（`--with-keys`）。

---

## 1. 在源机器上导出

```
/ship export --providers --config
```

要连密钥值一起带走（可选）：

```
/ship export --providers --config --with-keys
```

> `--with-keys` 会把**密钥明文**写进 `.secrets.env`（权限 600、已被 `.gitignore` 排除）。
> 目标机应用时**只会填它缺失的那些**，已存在的同名变量绝不覆盖。

指定输出目录：`--out=/path/to/dir`，覆盖已有：`--force`。

导出后会自动汇报：包数 / provider 数 / 配置数 / 是否带了密钥 / 警告。

---

## 2. 传到目标机器

**推荐**：`ssh 'cat > file' < local`（经堡垒机时 `scp` 会静默失败）

```bash
tar czf /tmp/bundle.tgz -C /path/to/bundle .
ssh TARGET 'cat > ~/bundle.tgz' < /tmp/bundle.tgz
ssh TARGET 'mkdir -p ~/pi-ship && tar xzf ~/bundle.tgz -C ~/pi-ship'
```

> macOS 上打包请加 `--no-mac-metadata`，或用 `tar czf x.tgz $(ls -A | grep -v '^\._')`，
> 否则会带上 `._*` 资源分叉文件（无害但脏）。

校验：两边 `md5sum` 应一致。

---

## 3. 在目标机器上运行

```bash
cd ~/pi-ship
chmod +x install.sh

./install.sh --preflight     # ① 只看自检，不改任何东西
./install.sh --dry-run       # ② 预演，仍然不改
./install.sh                 # ③ 交互式真正执行
```

### 交互式会问你什么

只在**必要**时提问，答案存进 `.pi-ship.conf`，之后再跑就不问了。

**问题 1 — node 安装方式**（仅当 node 缺失或版本 < 22.19）

| 选项 | 说明 |
|---|---|
| 1) nvm | **推荐**。用户级、免 sudo、可多版本 |
| 2) fnm | 更快的替代品 |
| 3) nodesource | 走 apt 系统级安装（**需要 sudo**） |
| 4) npm | `npm i -g node`，**适合 GitHub 被墙的网络** |
| 5) skip | 我自己装，稍后重跑 |

**问题 2 — node 版本**：22 LTS / **24 LTS（默认）** / latest

**问题 3 — 是否写 PATH**：让未来的 shell 都能找到 `pi`（写 `.profile` + `.bashrc` / `.zshenv` + `.zshrc`）

**问题 4 — 是否迁移密钥**：仅当 bundle 里带了密钥值时才问。**只填缺失的，绝不覆盖已有的。**

### 非交互模式

```bash
./install.sh --yes                        # 全部接受默认/存档答案
./install.sh --only=extensions            # 只跑某一层
./install.sh --only=extensions,providers
```

CI 或批量部署时，预先写 `.pi-ship.conf`：

```bash
CFG_INSTALL_PI=yes
CFG_NODE_METHOD=npmnode
CFG_NODE_VERSION=24
CFG_PATH=yes
CFG_SECRETS=yes
```

---

## 4. 跑完之后

脚本会打印验证结果。全部通过时：

```
✓ pi: 0.85.1
✓ packages: 11 configured (wanted 11)
✓ extension model-name.ts
✓ provider zhipu
✓ provider ksyun
pi-migrate: migration complete
  all checks passed.
```

### 加载密钥并启动

密钥**不会**自动进你的 shell（`.env` 只是文件）。二选一：

```bash
# A. 每次手动加载
set -a; . ~/pi-ship/.env; set +a
pi

# B. 让登录 shell 自动加载（写进 ~/.bashrc 或 ~/.zshenv）
[ -f ~/pi-ship/.env ] && set -a && . ~/pi-ship/.env && set +a
```

> 若 pi 已在运行：用 `/reload` 而不是重启。

---

## 5. 每步在做什么（install.sh 结构）

| 步骤 | 内容 |
|---|---|
| 1 | **自检** — 探测 pi / node / npm / 平台 / agent 目录，报告缺什么 |
| 2 | **配置** — 交互式提问（唯一会问你的地方） |
| 3 | **装 node** — 按选择用 nvm/fnm/nodesource/npm 安装；已有合格版本则跳过 |
| 4 | **装 pi** — 用**新装的那个 node 自带的 npm**，避免系统 npm 的 `EACCES` |
| 5 | **装扩展** — 逐个 `pi install`，失败只记录不中断 |
| 6 | **散装扩展** — 拷进 `~/.pi/agent/extensions/` |
| 7 | **provider** — merge 进 `models.json`（已有的不动），先备份 |
| 8 | **配置文件** — 拷 `web-search.json`、`sol-pi.json` 等（改前备份 `.bak-pi-migrate`） |
| 9 | **settings** — 只 merge 可移植的键 |
| 10 | **密钥** — 写 `.env`，**只填缺失的** |
| 11 | **PATH** — 可选，写进 shell profile |
| 12 | **验证** — 逐项核对，汇总通过/失败 |

任何一步失败都有明确提示，不会静默跳过。

---

## 6. 安全保证

- **不覆盖已有配置**。`models.json`、`settings.json` 是 merge；被改写的文件先备份成 `*.bak-pi-migrate`。
- **密钥只填不覆盖**。目标机已设的同名变量永远优先。
- **永不打包** `auth.json`（OAuth token）、`trust.json`、`models-store.json`、sessions。
- **导出时字面量密钥自动替换**成 `$VAR` 引用，名字进 `.env.example`。
- **`.secrets.env` 权限 600 且被 gitignore**。
- **可重复执行**，第二次是 no-op。

---

## 7. 已知限制

- **OAuth provider 需重新登录**：`openai-codex` 之类的 token 在 `auth.json`，不迁移。目标机上 `/login`。
- **`packages` 是并集而非快照**：runbook 用 `pi install` 逐个添加。若目标机已有别的包，会保留（这是有意的——严格快照需要删除操作，风险更高）。
- **只迁移用户级配置**：`~/.pi/agent/`。项目级 `.pi/` 不在范围内。
- **非交互 shell 的 PATH**：bash 在非交互模式下不读任何 profile，所以 `ssh host 'pi ...'` 可能找不到 `pi`。用 `ssh host 'bash -lc "pi ..."'`，或先 `export PATH`。
- **网络受限时**：`raw.githubusercontent.com` 常被墙。nvm 脚本有 4 个镜像回退（github.com / jsdelivr / gitee）+ git clone 兜底；都不行就用**选项 4（npm 方式）**。

---

## 8. 排障

| 现象 | 原因与处理 |
|---|---|
| `node ... is below pi's minimum` | node < 22.19。重跑并选 1 或 4 装新版 |
| `EACCES ... /usr/local/lib/node_modules` | 系统 npm 无权限。脚本会自动改装到 `~/.pi-node`；若仍失败，手动 `npm i -g --prefix ~/.pi-node node@24` |
| `Unexpected argument ...` | `pi install` 一次只吃一个 source。本脚本已逐个调用，出现即说明 bundle 版本过旧 |
| `Could not resolve host: raw.githubusercontent.com` | 用 npm 方式装 node（选项 4），或自己装好 node 后选 5 |
| `No API key found for the selected model` | 密钥没进 shell。`set -a; . .env; set +a` |
| `missing secrets: X` | 该变量目标机没有且 bundle 也没带 → 手动补进 `.env` |
| 扩展工具没出现 | `pi` 已在跑 → `/reload`；或确认 `settings.json` 的 `packages` 有 11 项 |

---

## 9. 真机验证记录

已在干净机器上完整跑通（Ubuntu 24.04 x86_64，**无 pi，node 仅 18.19.1**）：

1. `--preflight` 正确识别「无 pi + node 版本不足」✅
2. 自动装 node 24.21.0（npm 方式，因为 GitHub raw 被墙）✅
3. 自动装 pi 0.85.1（自动避开 `/usr/local` 权限问题）✅
4. 11 个扩展全部按锁定版本装成 ✅
5. 散装扩展 / 2 个 provider / 2 个配置文件 / 10 个 settings 全部落地 ✅
6. 密钥迁移：目标机已有的保留，缺失的补上 ✅
7. PATH 写入 profile，登录 shell 直接可用 ✅
8. **真实调用迁移后的 provider 返回预期结果** ✅
9. 二次运行幂等（文件 hash 不变）✅

另有 Ubuntu 22.04（无 node 无 npm）验证 nvm 路径通过。

---

## 10. 参考：命令速查

```bash
/ship help
/ship export [--providers] [--config] [--with-keys] [--out=DIR] [--force]
/ship preflight [<bundle>]
/ship plan <bundle>
/ship verify <bundle>
/ship inspect <bundle>
```

```bash
./install.sh --preflight
./install.sh --dry-run
./install.sh --yes
./install.sh --only=extensions
./install.sh --interactive
./install.sh --help
```