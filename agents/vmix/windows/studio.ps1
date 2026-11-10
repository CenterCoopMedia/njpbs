function Confirm-StudioCheck([string]$question) {
    return (Read-Host ($question + ' Type yes to confirm, or press Enter to stop')) -eq 'yes'
}

function Read-StudioConfiguration([string]$target, [string]$node) {
    $output = & $node (Join-Path $target 'read-studio-configuration.mjs') (Join-Path $target 'studio-config.json') (Join-Path $target 'pairing.json')
    if ($LASTEXITCODE -ne 0) { throw 'Invalid private studio configuration' }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Get-StudioInventory($preset) {
    $request = [Net.HttpWebRequest]::Create(('http://' + $preset.vmixHost + ':' + $preset.vmixPort + '/api/'))
    $request.AllowAutoRedirect = $false
    $request.Proxy = $null
    $request.Timeout = 5000
    $request.ReadWriteTimeout = 5000
    $response = $request.GetResponse()
    try {
        if ([int]$response.StatusCode -ne 200) { throw 'vMix API did not answer' }
        $settings = New-Object Xml.XmlReaderSettings
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $settings.MaxCharactersInDocument = 2000000
        $reader = [Xml.XmlReader]::Create($response.GetResponseStream(), $settings)
        try {
            $document = New-Object Xml.XmlDocument
            $document.XmlResolver = $null
            $document.Load($reader)
        } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
    $all = @($document.SelectNodes('/vmix/inputs/input'))
    $found = @{}
    foreach ($number in @($preset.backgroundInput,$preset.inputs.headline,$preset.inputs.name_title,$preset.overlayInputs.headline,$preset.overlayInputs.name_title)) {
        $matches = @($all | Where-Object { $_.GetAttribute('number') -eq [string]$number })
        if ($matches.Count -ne 1) {
            Write-Host ('STOP: vMix must have exactly one input numbered ' + $number + '. It has ' + $matches.Count + '.')
            throw 'Preset mismatch'
        }
        $found[$number] = $matches[0]
        if (-not $matches[0].GetAttribute('key') -or -not $matches[0].GetAttribute('title')) { throw 'Incomplete input identity' }
        Write-Host ('Found input ' + $number + ': ' + $matches[0].GetAttribute('title') + ' (' + $matches[0].GetAttribute('type') + ')')
    }
    foreach ($number in @($preset.inputs.headline,$preset.inputs.name_title)) {
        if ($found[$number].GetAttribute('type') -cne 'GT') {
            Write-Host ('STOP: Input ' + $number + ' is ' + $found[$number].GetAttribute('type') + '; a GT title is required.')
            throw 'Wrong input type'
        }
        $fields = @('TextBlock1.Text')
        if ($number -eq $preset.inputs.name_title) { $fields += 'TextBlock2.Text' }
        foreach ($field in $fields) {
            $matches = @($found[$number].SelectNodes('text') | Where-Object { $_.GetAttribute('name') -ceq $field })
            if ($matches.Count -ne 1) {
                Write-Host ('STOP: Input ' + $number + ' must have exactly one ' + $field + ' field.')
                throw 'Wrong title fields'
            }
        }
    }
    foreach ($route in @(@($preset.overlayInputs.headline,$preset.inputs.headline),@($preset.overlayInputs.name_title,$preset.inputs.name_title))) {
        foreach ($layer in @($route[1],$preset.backgroundInput)) {
            $key = $found[$layer].GetAttribute('key')
            $matches = @($found[$route[0]].SelectNodes('overlay') | Where-Object { $_.GetAttribute('key') -ceq $key })
            if ($matches.Count -ne 1) {
                Write-Host ('STOP: Input ' + $route[0] + ' must contain input ' + $layer + ' exactly once as a direct layer.')
                throw 'Wrong title layer'
            }
        }
    }
    $identities = @{}
    foreach ($number in @($preset.inputs.headline,$preset.inputs.name_title,$preset.overlayInputs.headline,$preset.overlayInputs.name_title)) {
        $identities[$number] = [ordered]@{key=$found[$number].GetAttribute('key'); number=$number; title=$found[$number].GetAttribute('title')}
    }
    return [ordered]@{
        inputs=[ordered]@{headline=$identities[$preset.inputs.headline]; name_title=$identities[$preset.inputs.name_title]}
        overlayInputs=[ordered]@{headline=$identities[$preset.overlayInputs.headline]; name_title=$identities[$preset.overlayInputs.name_title]}
    }
}

function Read-ConnectorSetup([string]$sessionId, $inventory, $preset) {
    Write-Host 'In Boardwalk, copy the connector setup. Return here and press Enter to read it from the clipboard.'
    Read-Host | Out-Null
    $text = Get-Clipboard -Raw
    if (-not $text -or $text.Length -gt 16000) { throw 'Missing setup data' }
    $config = $text | ConvertFrom-Json
    $allowed = @('endpoint','deviceId','sessionId','vmixPort','exclusiveOverlay1','mapping','titleFilesConfirmed')
    foreach ($property in $config.PSObject.Properties.Name) {
        if ($property -notin $allowed) { throw 'Unexpected setup field' }
    }
    if ($config.endpoint -cne ($preset.apiOrigin + '/cmsLiveProductionAgent') -or $config.sessionId -cne $sessionId -or
        $config.titleFilesConfirmed -isnot [bool] -or $config.titleFilesConfirmed -ne $true -or $config.vmixPort -ne $preset.vmixPort -or $config.exclusiveOverlay1 -isnot [bool] -or $config.exclusiveOverlay1 -ne $true -or
        $config.deviceId -notmatch '^[A-Za-z0-9_-]{1,128}$' -or $config.mapping.sessionId -cne $sessionId -or
        $config.mapping.deviceId -cne $config.deviceId -or $config.mapping.state -cne 'uncommissioned') {
        throw 'Setup identities or state differ'
    }
    foreach ($group in @('inputs','overlayInputs')) {
        foreach ($template in @('headline','name_title')) {
            $expected = $inventory[$group][$template]
            $actual = $config.mapping.$group.$template
            if ($actual.key -cne $expected.key -or $actual.number -ne $expected.number -or $actual.title -cne $expected.title) {
                Write-Host ('STOP: Boardwalk mapping differs from the live vMix ' + $group + ' for ' + $template + '.')
                throw 'Mapping mismatch'
            }
        }
    }
    if ($config.mapping.schemaVersion -ne 1 -or $config.mapping.overlay -ne 1 -or
        ($config.mapping.version -isnot [long] -and $config.mapping.version -isnot [int]) -or $config.mapping.version -lt 1) {
        throw 'Invalid mapping version'
    }
    # Keep only the public fields that the connector uses.
    return [PSCustomObject]@{endpoint=$config.endpoint; deviceId=$config.deviceId; sessionId=$sessionId; vmixPort=$preset.vmixPort; exclusiveOverlay1=$true;
        mapping=[ordered]@{schemaVersion=1; sessionId=$sessionId; deviceId=$config.deviceId; version=$config.mapping.version; overlay=1;
            state='uncommissioned'; verifiedAtMs=$null; inputs=$inventory.inputs; overlayInputs=$inventory.overlayInputs}}
}

function Set-UpStudioSession([string]$target, [string]$node, [string]$agent, $preset) {
    if (Test-Path -LiteralPath (Join-Path $target 'config.json')) {
        Write-Host 'A session configuration already exists. It was kept. Use Start for that session; ask support before changing it.'
        return
    }
    if (-not (Confirm-StudioCheck 'Is vMix running with the configured preset, with all broadcast feeds disconnected and recording and streaming off?')) {
        Write-Host 'Stopped safely. Run setup again when the off-air studio is ready.'
        return
    }
    Write-Host 'Checking the preset through the configured loopback vMix Web Controller. This reads settings only.'
    $script:setupStep = 'Reading the local vMix Web Controller. Check the private configuration and configured loopback API access with support.'
    $inventory = Get-StudioInventory $preset
    if (-not (Confirm-StudioCheck 'Have you checked both actual GT source files against titleFiles in studio-config.json?')) {
        Write-Host 'Stopped safely. Check the two actual GT files with the studio operator before setup continues.'
        return
    }
    if (-not (Confirm-StudioCheck 'Have you checked that these four inputs use only Overlay 1 and the two named direct layers, with no other composites, overlays, direct outputs or additional mixes?')) {
        Write-Host 'Stopped safely. Ask the studio operator to check the output routes before setup continues.'
        return
    }
    $inventoryPath = Join-Path $target 'studio-inputs.json'
    [IO.File]::WriteAllText($inventoryPath, ($inventory | ConvertTo-Json -Depth 10 -Compress), (New-Object Text.UTF8Encoding($false)))
    $inventory | ConvertTo-Json -Depth 10 -Compress | Set-Clipboard
    Write-Host 'The actual input identities are saved. In Boardwalk, use Load studio input details to load studio-inputs.json.'
    Write-Host ('A copy is saved in ' + $inventoryPath + '. It contains no banner text or credential.')
    Write-Host 'If Studio setup controls are unavailable, stop setup and contact njpbs@montclair.edu. Continue when the session ID and connector setup are available in Boardwalk.'
    $sessionId = Read-Host 'Paste the Session ID from Boardwalk Studio setup, or press Enter to stop'
    if (-not $sessionId) { return }
    if ($sessionId -cnotmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Invalid session ID' }
    $script:setupStep = 'Reading Boardwalk connector setup. Use Copy connector setup in Boardwalk, then return and press Enter. The session must still be a draft.'
    $config = Read-ConnectorSetup $sessionId $inventory $preset
    $journal = Join-Path $target ('sessions\' + $sessionId)
    $config | Add-Member -NotePropertyName journalDirectory -NotePropertyValue $journal
    $pending = Join-Path $target 'config.pending.json'
    $configPath = Join-Path $target 'config.json'
    $previousEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($pending, ($config | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
        $script:setupStep = 'Verifying the session mapping. Check the connection, paired PC and draft session with support.'
        $verifiedOutput = & $node $agent --config $pending --stored-credentials --verify-mapping
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'FAIL: Boardwalk could not verify this preset. Keep the session in draft. Check the device, input mapping and connection with support.'
            throw 'Mapping verification failed'
        }
        $mapping = ($verifiedOutput -join "`n") | ConvertFrom-Json
        if ($mapping.state -cne 'commissioned' -or $mapping.sessionId -cne $sessionId -or $mapping.deviceId -cne $config.deviceId -or $mapping.version -ne $config.mapping.version) {
            throw 'Verification response differs'
        }
        $script:setupStep = 'Saving the verified session. Ask support to check account permissions before you try again.'
        $config.mapping = $mapping
        # CreateNew prevents setup from replacing a config created by another setup window.
        $json = $config | ConvertTo-Json -Depth 20
        $stream = New-Object IO.FileStream($configPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $bytes = [Text.Encoding]::UTF8.GetBytes($json); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        Write-Host 'PASS: Boardwalk and vMix agree on this session mapping. No banner text was changed.'
        Write-Host 'In Boardwalk, mark the session ready, then active. Then run Start Studio connector.'
    } finally {
        [Console]::OutputEncoding = $previousEncoding
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending }
    }
}
