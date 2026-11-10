param([switch]$SelfTestOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:setupStep = 'Copying connector files into your Windows user folder.'

. (Join-Path $PSScriptRoot 'install.ps1')

try {
    Write-Host 'Setting up the NJ PBS Studio connector in your Windows user folder.'
    $target = Install-Connector
    $node = Join-Path $target 'runtime\node.exe'
    $agent = Join-Path $target 'vmix-agent.cjs'
    $script:setupStep = 'Running the connector self-test. Do not continue if the self-test fails.'
    & $node $agent --simulate
    if ($LASTEXITCODE -ne 0) { throw 'Connector self-test failed' }
    if (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($target)) 'vmix-agent-setup.lock')) { throw 'Connector setup lock exists' }
    Remove-Item -LiteralPath (Join-Path $target 'self-test.pending')
    Write-Host 'PASS: The connector self-test passed. This did not connect to vMix or Boardwalk.'
    if ($SelfTestOnly) {
        Write-Host 'Self-test complete. Pairing was not started.'
        exit 0
    }
    . (Join-Path $target 'studio.ps1')
    $script:setupStep = 'Reading studio-config.json. Ask support to supply the private preset configuration before pairing.'
    $preset = Read-StudioConfiguration $target $node
    if (-not (Test-Path -LiteralPath (Join-Path $target 'credential.dpapi'))) {
        $answer = Read-Host 'Do you have a fresh Boardwalk pairing code? Type yes to pair now, or press Enter to stop'
        if ($answer -ne 'yes') {
            Write-Host 'Setup files are ready. Pairing happens at the studio test. Run Set up Studio connector again when you have a code.'
            exit 0
        }
        Write-Host 'The next prompt hides your code. Paste or type the code, then press Enter.'
        $script:setupStep = 'Pairing this PC. Follow the pairing message above. Revoke a failed enrollment in Boardwalk before a new code is used.'
        & $node $agent --pair (Join-Path $target 'pairing.json')
        if ($LASTEXITCODE -ne 0) { throw 'Pairing did not finish. Follow the message above. Do not share the code or any credential file.' }
        Write-Host 'Pairing passed. Refresh devices in Boardwalk and check that this PC says Enrolled.'
    } else {
        Write-Host 'This Windows account already has a paired connector. Its saved credential was kept.'
    }
    Set-UpStudioSession $target $node $agent $preset
} catch {
    Write-Host 'STOP: Setup did not finish. Your existing settings and journals were kept.'
    Write-Host $script:setupStep
    $knownStops = @{
        'Missing setup data'='Copy connector setup in Boardwalk first. The clipboard is empty or too large.'
        'Unexpected setup field'='The clipboard does not contain the expected connector setup. Copy connector setup again.'
        'Setup identities or state differ'='The copied setup does not match this draft session. Check the Session ID, paired PC and confirmation boxes.'
        'Invalid mapping version'='The copied mapping has an invalid schema, overlay or version. Ask support to check it.'
        'Invalid session ID'='The Session ID is not valid. Use Copy session ID in Boardwalk.'
        'Verification response differs'='Boardwalk returned a different mapping. Leave the session in draft and contact support.'
        'Connector lock exists'='Stop the connector and ask support to check the existing lock. Do not remove it yourself.'
        'Connector setup lock exists'='Another setup is running or an earlier setup needs recovery. Do not start the connector or remove the setup lock. Ask support to inspect the backup and incoming folders beside the install.'
        'Connector package is incomplete'='The extracted package is incomplete. Download and extract a fresh package from Boardwalk.'
        'Installed package changed during confirmation'='Another setup changed the installed package while confirmation was pending. Your files were kept. Run setup again and review the revisions.'
        'Incoming package changed during setup'='The extracted package changed while setup was pending. Use a fresh reviewed download and run setup again.'
        'Replacement not confirmed'='The existing connector was kept. Confirm the reviewed source and journal compatibility with support before replacement.'
        'Connector self-test failed'='The self-test did not pass. Start remains blocked. Keep the previous-package backup shown above and ask support before retrying setup.'
        'Connector is running'='Stop every Studio connector window before running setup again.'
        'Connector install needs recovery'='The previous package could not be fully restored. Do not start the connector or remove its setup lock. Ask support to recover the backup and incoming folders shown above.'
        'Package files differ from inventory'='The download is incomplete or changed. Download and extract a fresh package from Boardwalk.'
        'Invalid package inventory'='Download and extract a fresh package from Boardwalk. Its file inventory is missing or invalid.'
        'Incomplete input identity'='A required vMix input has no key or display name. Check the configured preset with support.'
    }
    if ($knownStops.ContainsKey($_.Exception.Message)) { Write-Host $knownStops[$_.Exception.Message] }
    Write-Host 'Contact NJ PBS support. Do not send credential files, pairing codes, or screenshots of codes.'
    exit 1
}
