param(
    [Parameter(Mandatory = $true)][string]$MacAddress,
    [Parameter(Mandatory = $true)][string]$MacPublicKey,
    [string]$ExpectedUser = 'luw'
)
$ErrorActionPreference = 'Stop'

function Start-CheckedSshd {
    param([switch]$Restart)
    try {
        if ($Restart) { Restart-Service sshd }
        elseif ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd }
    } catch {
        $failure = $_
        Write-Warning 'sshd failed to start. Collecting configuration and startup errors; original files are preserved.'
        $diagnostic = Join-Path $PSScriptRoot 'diagnose-windows-ssh.ps1'
        if (Test-Path -LiteralPath $diagnostic) {
            & $diagnostic
        } else {
            $ErrorActionPreference = 'Continue'
            & "$env:WINDIR\System32\OpenSSH\sshd.exe" -t 2>&1 | Out-Host
            Write-Output "sshd -t exit code: $LASTEXITCODE"
            Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 8 -ErrorAction SilentlyContinue |
                Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-List
        }
        throw $failure
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run PowerShell as administrator under the Windows account that owns the session logs.'
}
if ($env:USERNAME -ine $ExpectedUser) { throw "Expected Windows user: $ExpectedUser; actual: $env:USERNAME" }
if ($MacAddress -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$') { throw 'MacAddress must be an IPv4 address.' }
if ($MacPublicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$') { throw 'Paste the full Mac public key on one line.' }

$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
if ($capability.State -ne 'Installed') {
    $installed = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
    if ($installed.RestartNeeded) { throw 'Restart Windows, then run this script again.' }
}

# Keep a receipt before narrowing the default SSH firewall rule. No rules are deleted.
$rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($rule) {
    # Do not create the OpenSSH system directory with inherited user-folder permissions before sshd initializes it.
    $backup = Join-Path $env:USERPROFILE ('token-watcher-ssh-backups\firewall-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
    New-Item -ItemType Directory -Force -Path (Split-Path $backup) | Out-Null
    [pscustomobject]@{
        Enabled = [string]$rule.Enabled
        Profile = [string]$rule.Profile
        RemoteAddress = @($rule | Get-NetFirewallAddressFilter | Select-Object -ExpandProperty RemoteAddress)
    } | Export-Clixml -LiteralPath $backup
    Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -RemoteAddress $MacAddress
} else {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH from token-watcher Mac' `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress $MacAddress | Out-Null
}

# The first start creates the default sshd_config and host keys after the firewall is scoped.
Start-CheckedSshd

# This elevated account is an administrator; default Windows sshd uses this shared key file.
$authorized = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$entry = 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ' + $MacPublicKey
if (!(Test-Path -LiteralPath $authorized) -or !(Select-String -LiteralPath $authorized -SimpleMatch $MacPublicKey -Quiet)) {
    Add-Content -LiteralPath $authorized -Value ("`n" + $entry) -Encoding ascii
}
& icacls.exe $authorized /inheritance:r /grant:r '*S-1-5-32-544:(F)' '*S-1-5-18:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to set authorized_keys ACL.' }
& "$env:WINDIR\System32\OpenSSH\sshd.exe" -t
if ($LASTEXITCODE -ne 0) { throw 'Existing sshd_config is invalid; fix it before starting sshd.' }
Set-Service -Name sshd -StartupType Automatic
if ((Get-Service sshd).Status -eq 'Running') { Start-CheckedSshd -Restart } else { Start-CheckedSshd }

# Return public host identity and aggregate root checks, never conversation contents.
$hostKey = Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key.pub'
$fingerprint = & "$env:WINDIR\System32\OpenSSH\ssh-keygen.exe" -lf $hostKey
if ($LASTEXITCODE -ne 0) { throw 'Unable to read public SSH host identity.' }
$roots = @('.claude\projects', '.codex\sessions', '.codex\archived_sessions') | ForEach-Object {
    $path = Join-Path $env:USERPROFILE $_
    [pscustomobject]@{ root = $_; exists = (Test-Path -LiteralPath $path -PathType Container) }
}
[pscustomobject]@{
    user = $env:USERNAME
    sshd = [string](Get-Service sshd).Status
    macAllowed = $MacAddress
    listening22 = [bool](Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue)
    fingerprint = [string]$fingerprint
    hostPublicKey = (Get-Content -LiteralPath $hostKey -Raw).Trim()
    roots = @($roots)
} | ConvertTo-Json -Depth 4
