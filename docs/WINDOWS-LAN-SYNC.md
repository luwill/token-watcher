# Windows 内网用量元数据同步

Mac 每 5 小时通过 SSH 触发 Windows 本机导出，再用 SFTP 拉取白名单元数据。现有 token-watcher 从这些文件采集用量。Windows 原始会话留在原机，导出器和同步器不打开数据库。

## 传输范围

- Claude Code：assistant 的时间、模型、输入/缓存/输出 token 数，以及哈希化会话、消息和请求标识。
- Codex：时间、模型、累计/单次 token 数、压缩用量、哈希化会话和响应标识。保留极少数无内容的事件标记，供现有采集器识别压缩与回放。
- 项目统一为 `windows-office`，不导出公司项目名称或真实路径。
- 对话正文、代码、提示词、工具名称/参数/输出、凭证、账号和限额明细均不导出。

Windows 只读扫描当前用户 `.claude/projects`、`.codex/sessions` 和 `.codex/archived_sessions` 的普通 `.jsonl`。WSL、自定义配置目录和其他工具未覆盖。遇到压缩日志或内容重写会停止本轮同步并报错，不静默漏采。归档与活动 Codex 会话统一输出到 `codex/sessions`。

## 文件与配置

Windows 需要 Node >=22.13 和运行中的 OpenSSH Server。`scripts/setup-windows-sync.ps1` 配置专用公钥、限 Mac 地址的防火墙和自动启动服务。已有公钥保留，防火墙旧设置有备份。首次连接需从 Windows 本机输出核对主机公钥，并固定专用 `known_hosts`。

导出器 `scripts/windows-usage-export.mjs` 部署为 Windows 当前用户目录下 `.tokenmeter/windows-usage-export/exporter.mjs`。只导出白名单字段，哈希化文件名；索引中的原始路径保留在 Windows，不传输该索引。源文件新增时重新投影，未变化时跳过；源重写时保留此前安全导出并报错。

Mac 安装 `scripts/windows-usage-sync.mjs` 及其依赖 `windows-usage-export.mjs`。前者读取配置，例如：

```json
{
  "mode": "usage-metadata",
  "target": "windows-user@192.0.2.10",
  "interface": "en0",
  "identityFile": "/absolute/path/to/dedicated-private-key",
  "knownHostsFile": "/absolute/path/to/verified-known_hosts",
  "remoteExportRoot": "C:/Users/windows-user/.tokenmeter/windows-usage-export",
  "mirrorRoot": "/absolute/path/to/windows-usage"
}
```

同步器只接受指定导出目录下的 `usage-<哈希标识>.jsonl`，拒绝原始会话路径。下载后校验长度、SHA-256 和嵌套字段白名单，验证通过才原子发布到 Mac 的 `windows-usage` 目录；文件权限为 600，暂存文件不进入采集 roots。失败不推进成功状态，未变化的哈希不重复下载。旧版完整镜像脚本要求显式 `full-session-mirror` 模式，当前方案不使用它。

## 启用顺序

1. 验证真实 SSH 握手、主机身份和免密登录。TUN 接管可能使 TCP 测试假成功；使用 Mac `nc -4 -b en0` 绑定物理网卡，经已验证的 SSH 连接同步，无需修改系统路由。
2. 测试白名单投影和现有采集器兼容；上传导出器并核对 SHA-256。部署步骤成功后，才安装并核对 Mac 程序与配置，之后单独运行首次同步。
3. 在内存中核算导出数据，并检查重复同步。先准备 pending roots，保留已有 VPS roots。
4. 按项目 AGENTS 要求取得数据库操作确认，再备份正式库、登记 `windows-usage/claude/projects` 与 `windows-usage/codex/sessions` 并重启现有单一服务。不能提前登记 roots，以免其他启动自动导入。
5. 启用独立 Mac LaunchAgent `com.tokenmeter.windows-sync`：`StartInterval=18000`，`RunAtLoad=true`，使用 Node/脚本/配置的绝对路径。Windows 不需要新增计划任务；已有 VPS 同步保持原周期。

## 验证与维护

```bash
node --check scripts/windows-usage-export.mjs
node --check scripts/windows-usage-sync.mjs
node test/windows-usage.mjs
node /absolute/path/sync-windows.mjs /absolute/path/windows-sync.json
```

`npm test` 包含这些专项检查、内存 SQLite 对账及隔离临时目录清理；不会访问真实用量库。

Windows 本机可用管理员 PowerShell 检查：

```powershell
Get-Service sshd
Get-NetTCPConnection -LocalPort 22 -State Listen
node.exe --version
```

若服务无法启动，用 `scripts/diagnose-windows-ssh.ps1` 检查实际程序路径、`sshd -t` 退出码和系统事件。`0xC0000139` 可能表示组件所需 DLL 入口缺失，应核对 OpenSSH 客户端、服务端与依赖版本，避免仅凭超时重置权限。

Mac DHCP 地址变化时更新 Windows 防火墙来源；Windows 地址变化时重新核对主机身份与目标地址。Mac 睡眠或 Windows 关机期间不能按时同步，恢复可达后在下一次触发补采。

来源：[微软 OpenSSH 安装与服务配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)、[Windows 公钥位置与 ACL](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)、[OpenSSH 组件错配与启动超时](https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/openssh-server-service-wont-start-error-1053)。

## 发布范围与限制

npm 包包含用量白名单导出器、Mac 同步器及 Windows SSH 配置/诊断辅助脚本；Python 视频脚本与旧版完整会话镜像工具只保存在 GitHub 源码中。没有安装后自动执行的同步或防火墙操作。

跨平台合成测试覆盖原始/投影日志经实际采集器与 Store 的 token、模型和时间一致性，重复采集幂等，未知字段/未脱敏标识拒绝，源重写保留旧导出，传输失败保留旧镜像与游标。真实 OpenSSH SFTP 路径测试仅在系统自带 sftp-server 可用时运行；其他平台继续运行全部模拟传输断言。

SSH 可达性、Windows 服务配置和权限需要在目标机器验证。Mac 与 Windows 需开机并处于允许互通的网络；本版本不会更改现有同步任务、SSH 配置或正式用量库中的 token 数。
