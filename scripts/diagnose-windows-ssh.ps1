# Read startup diagnostics; do not change service/configuration/ACLs or print private key contents.
$ErrorActionPreference = 'Continue'
$sshHome = Join-Path $env:ProgramData 'ssh'
$sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'

Write-Output '=== OpenSSH binary and Windows build ==='
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' |
    Select-Object DisplayVersion, CurrentBuild, UBR | Format-List
if (Test-Path -LiteralPath $sshd) {
    (Get-Item -LiteralPath $sshd).VersionInfo | Select-Object FileVersion, ProductVersion | Format-List
}
Write-Output '=== Inbox OpenSSH and crypto component versions ==='
foreach ($path in @(
    (Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'),
    (Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'),
    (Join-Path $env:WINDIR 'System32\OpenSSH\libcrypto.dll'),
    (Join-Path $env:WINDIR 'System32\libcrypto.dll')
)) {
    if (Test-Path -LiteralPath $path) {
        (Get-Item -LiteralPath $path).VersionInfo |
            Select-Object FileName, FileVersion, ProductVersion | Format-List
    } else { Write-Output ("NOT PRESENT: " + $path) }
}
Write-Output '=== Service state, exit codes and executable ==='
Get-CimInstance Win32_Service -Filter "Name='sshd'" |
    Select-Object State, StartMode, StartName, ExitCode, ServiceSpecificExitCode, PathName | Format-List
& "$env:WINDIR\System32\sc.exe" qc sshd
& "$env:WINDIR\System32\sc.exe" query sshd

Write-Output '=== Configuration validation (no output + exit 0 means valid) ==='
if (Test-Path -LiteralPath $sshd) {
    & $sshd -t 2>&1 | Out-Host;
    $validationExit = $LASTEXITCODE;
    Write-Output "sshd -t exit code: $validationExit";
    Write-Output ('sshd -t hexadecimal exit code: 0x' + ([int]$validationExit).ToString('X8'));
    if ($validationExit -eq -1073741511) {
        Write-Warning '0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND: a required DLL entry point is unavailable. Check component compatibility before changing SSH configuration or ACLs.'
        Write-Output 'Microsoft documented OpenSSH Client/Server/libcrypto.dll mismatch: https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/openssh-server-service-wont-start-error-1053'
    }
}

Write-Output '=== SSH directory/config ACL and missing files ==='
foreach ($path in @($sshHome, (Join-Path $sshHome 'logs'), (Join-Path $sshHome 'sshd_config'))) {
    Write-Output $path
    if (Test-Path -LiteralPath $path) {
        Get-Acl -LiteralPath $path | Select-Object Owner, AccessToString | Format-List
    } else { Write-Output 'NOT PRESENT' }
}
foreach ($name in @('ssh_host_ed25519_key', 'ssh_host_rsa_key', 'ssh_host_ecdsa_key')) {
    [pscustomobject]@{ file = $name; exists = (Test-Path -LiteralPath (Join-Path $sshHome $name)) } | Format-Table -AutoSize
}
Write-Output '=== Local port 22 listeners ==='
Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize

Write-Output '=== Recent OpenSSH startup events ==='
$since = (Get-Date).AddDays(-1)
foreach ($log in @('OpenSSH/Operational', 'OpenSSH/Admin')) {
    Write-Output $log
    try {
        Get-WinEvent -ListLog $log -ErrorAction Stop |
            Select-Object LogName, IsEnabled, RecordCount | Format-List
        Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $since } -MaxEvents 8 -ErrorAction Stop |
            Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-List
    } catch { Write-Output ("Event query: " + $_.Exception.Message) }
}
Write-Output '=== Service Control Manager errors for OpenSSH ==='
Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = $since } `
    -MaxEvents 300 -ErrorAction Continue |
    Where-Object { $_.Message -match 'sshd|OpenSSH' } | Select-Object -First 5 |
    Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-List
Write-Output '=== Application crash records for OpenSSH ==='
Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = @(1000, 1001); StartTime = $since } `
    -MaxEvents 100 -ErrorAction Continue |
    Where-Object { $_.Message -match 'sshd|OpenSSH' } | Select-Object -First 5 |
    Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-List
