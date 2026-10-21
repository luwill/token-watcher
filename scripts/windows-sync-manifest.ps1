$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Read metadata only. Do not enumerate credentials, configuration, or databases.
$roots = @(
    @{ Bucket = 'claude/projects'; Relative = '.claude\projects'; Codex = $false },
    @{ Bucket = 'codex/sessions'; Relative = '.codex\sessions'; Codex = $true },
    @{ Bucket = 'codex/archived_sessions'; Relative = '.codex\archived_sessions'; Codex = $true }
)
$files = New-Object System.Collections.Generic.List[object]
$found = New-Object System.Collections.Generic.List[string]
foreach ($root in $roots) {
    $base = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE $root.Relative))
    if (!(Test-Path -LiteralPath $base -PathType Container)) { continue }
    $found.Add($root.Bucket)
    # Walk explicitly so junctions and symbolic links are never followed.
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($base)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($file in Get-ChildItem -LiteralPath $directory -Force) {
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
            if ($file.PSIsContainer) { $pending.Push($file.FullName); continue }
            $match = $file.Name.EndsWith('.jsonl', [StringComparison]::OrdinalIgnoreCase)
            if ($root.Codex) { $match = $file.Name -match '\.jsonl(?:\.zst|\.zstd)?$' }
            if (!$match) { continue }
            $files.Add([pscustomobject]@{
                bucket = $root.Bucket
                relative = $file.FullName.Substring($base.Length + 1).Replace('\', '/')
                remote = '/' + $file.FullName.Replace('\', '/')
                size = $file.Length
                mtime = ([DateTimeOffset]$file.LastWriteTimeUtc).ToUnixTimeMilliseconds()
            })
        }
    }
}
ConvertTo-Json -InputObject @{
    version = 1
    home = '/' + $env:USERPROFILE.Replace('\', '/')
    roots = @($found.ToArray())
    files = @($files.ToArray())
} -Depth 4 -Compress
