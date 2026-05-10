Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo ".env"

Get-Content $envFile | Where-Object { $_ -and -not $_.TrimStart().StartsWith("#") } | ForEach-Object {
  $parts = $_ -split "=", 2
  if ($parts.Count -eq 2) {
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
  }
}

Set-Location $repo
npm run dev:api
