$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$target = Join-Path $env:LOCALAPPDATA 'NJPBS\vmix-agent'
if (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($target)) 'vmix-agent-setup.lock')) {
    Write-Host 'Studio setup is in progress or needs recovery. Ask support before starting the connector.'
    exit 1
}
if (Test-Path -LiteralPath (Join-Path $target 'self-test.pending')) {
    Write-Host 'The connector self-test has not passed. Run setup again; ask support before starting.'
    exit 1
}
$node = Join-Path $target 'runtime\node.exe'
$agent = Join-Path $target 'vmix-agent.cjs'
$config = Join-Path $target 'config.json'
$credential = Join-Path $target 'credential.dpapi'
if (-not (Test-Path -LiteralPath $config) -or -not (Test-Path -LiteralPath $credential)) {
    Write-Host 'The connector is not ready to start. Run Set up Studio connector first.'
    Write-Host 'The studio session must be paired and verified before a show.'
    exit 1
}
Write-Host 'Starting the Studio connector for this Windows account.'
Write-Host 'Keep this window open. To stop, press Ctrl+C and wait for the connector to finish.'
Write-Host 'If you close the window and the next start fails, ask support to check stale locks. Do not delete them yourself.'
Write-Host 'Stopping does not remove a graphic from vMix. Use native vMix controls if needed.'
try {
    Set-Location -LiteralPath $target
    & $node $agent --config $config --stored-credentials
    exit $LASTEXITCODE
} catch {
    Write-Host 'The connector could not start. Contact NJ PBS support. Keep your settings and journal files.'
    exit 1
}
