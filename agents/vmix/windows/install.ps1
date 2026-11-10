# The download must come from Boardwalk's reviewed, checksum-identified package.
# This inventory checks extraction/staging integrity; it is not a signature.
$script:connectorPackageNames = @('vmix-agent.cjs','setup.ps1','install.ps1','start.ps1','studio.ps1','pairing.json','configuration.mjs','read-studio-configuration.mjs','studio-config.example.json','Set up Studio connector.cmd','Start Studio connector.cmd','READ ME FIRST.txt','Studio test guide.txt','source.json','package-files.json')

function Get-ConnectorPackage([string]$source) {
    $root = Get-Item -LiteralPath $source -Force
    if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe package path' }
    foreach ($name in $script:connectorPackageNames + @('runtime\node.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) { throw 'Connector package is incomplete' }
    }
    $manifestPath = Join-Path $source 'package-files.json'
    $manifestFile = Get-Item -LiteralPath $manifestPath -Force
    if ($manifestFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe package path' }
    if ($manifestFile.Length -gt 4MB) { throw 'Invalid package inventory' }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if (($manifest.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'files,schemaVersion,sourceSha' -or
        $manifest.schemaVersion -ne 1 -or $manifest.sourceSha -isnot [string] -or
        $manifest.sourceSha -cnotmatch '^[a-f0-9]{40}$' -or $manifest.files -isnot [PSCustomObject]) { throw 'Invalid package inventory' }
    $files = @($script:connectorPackageNames | Where-Object { $_ -ne 'package-files.json' } | ForEach-Object { Get-Item -LiteralPath (Join-Path $source $_) -Force })
    $runtime = Get-Item -LiteralPath (Join-Path $source 'runtime') -Force
    if (-not $runtime.PSIsContainer -or ($runtime.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe package path' }
    $runtimeEntries = @(Get-ChildItem -LiteralPath $runtime.FullName -Recurse -Force)
    foreach ($item in @($files) + $runtimeEntries) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe package path' }
    }
    if (@($files | Where-Object { $_.PSIsContainer }).Count) { throw 'Invalid package inventory' }
    $files += @($runtimeEntries | Where-Object { -not $_.PSIsContainer })
    if (-not (Test-Path -LiteralPath (Join-Path $source 'runtime\node.exe') -PathType Leaf)) { throw 'Runtime is missing' }
    $properties = @($manifest.files.PSObject.Properties)
    if ($properties.Count -ne $files.Count -or $files.Count -gt 10000) { throw 'Package files differ from inventory' }
    $hashes = New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
    foreach ($property in $properties) {
        if ($property.Value -isnot [string] -or $property.Value -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid package inventory' }
        $hashes.Add($property.Name, $property.Value)
    }
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.FullName.Length + 1).Replace('\','/')
        if (-not $hashes.ContainsKey($relative) -or
            (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hashes[$relative]) { throw 'Package files differ from inventory' }
    }
    return $manifest
}

function Assert-ConnectorStopped([string]$target) {
    $locks = Join-Path $env:USERPROFILE '.njpbs-vmix-agent\locks'
    if ((Test-Path -LiteralPath $locks) -and @(Get-ChildItem -LiteralPath $locks -Filter '*.lock' -Force).Count) { throw 'Connector lock exists' }
    if ((Test-Path -LiteralPath $target) -and @(Get-ChildItem -LiteralPath $target -Recurse -Filter '*.lock' -Force).Count) { throw 'Connector lock exists' }
    $node = Join-Path $target 'runtime\node.exe'
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
        if ($process.ExecutablePath -eq $node -or $process.CommandLine -match 'vmix-agent\.cjs') { throw 'Connector is running' }
    }
}

# Capture package bytes for the confirmation race check, never user state.
function Get-ConnectorInstallSnapshot([string]$target, $names) {
    if (-not (Test-Path -LiteralPath $target)) { return '' }
    $root = (Get-Item -LiteralPath $target -Force).FullName
    $items = @()
    foreach ($name in $names) {
        $path = Join-Path $target $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $item = Get-Item -LiteralPath $path -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe installed package path' }
        $items += $item
        if ($item.PSIsContainer) { $items += @(Get-ChildItem -LiteralPath $path -Recurse -Force) }
    }
    if ($items.Count -gt 10000) { throw 'Unsafe installed package path' }
    return (@($items | Sort-Object FullName | ForEach-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe installed package path' }
        $hash = 'directory'
        if (-not $_.PSIsContainer) { $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
        [ordered]@{path=$_.FullName.Substring($root.Length + 1); hash=$hash}
    }) | ConvertTo-Json -Depth 4 -Compress)
}

function Install-Connector([string]$source = $PSScriptRoot, [string]$target = (Join-Path $env:LOCALAPPDATA 'NJPBS\vmix-agent')) {
    $source = [IO.Path]::GetFullPath($source).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($target).TrimEnd('\')
    $manifest = Get-ConnectorPackage $source
    $parent = [IO.Path]::GetDirectoryName($target)
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    foreach ($directory in @($parent, $target)) {
        if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe package path' }
    }
    $lockPath = Join-Path $parent 'vmix-agent-setup.lock'
    if (Test-Path -LiteralPath $lockPath) { throw 'Connector setup lock exists' }
    Assert-ConnectorStopped $target
    $names = $script:connectorPackageNames + @('runtime','install-record.json','self-test.pending')
    $existing = @()
    if (Test-Path -LiteralPath $target) {
        foreach ($item in @(Get-ChildItem -LiteralPath $target -Force)) {
            if ($item.Name -in $names) {
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($item.PSIsContainer -and $item.Name -ne 'runtime')) { throw 'Unsafe installed package path' }
                $existing += $item.Name
            } elseif ($item.Name -notin @('credential.dpapi','config.json','config.pending.json','studio-inputs.json','sessions')) {
                Write-Host ('Kept unrecognized local item: ' + $item.Name)
            }
        }
    }
    $previous = $null
    if ($existing.Count) {
        try { $previous = Get-ConnectorPackage $target } catch { $previous = $null }
    }
    $samePackage = $null -ne $previous -and $previous.sourceSha -ceq $manifest.sourceSha
    if ($samePackage) {
        if (@($previous.files.PSObject.Properties).Count -ne @($manifest.files.PSObject.Properties).Count) { $samePackage = $false }
        foreach ($property in $manifest.files.PSObject.Properties) {
            $old = $previous.files.PSObject.Properties[$property.Name]
            if ($null -eq $old -or $old.Value -cne $property.Value) { $samePackage = $false }
        }
    }
    $confirmedSnapshot = Get-ConnectorInstallSnapshot $target $names
    if ($existing.Count -and $source -ne $target -and -not $samePackage) {
        $oldRevision = 'unknown (legacy or changed package)'
        if ($null -ne $previous) { $oldRevision = $previous.sourceSha }
        Write-Host ('Installed source: ' + $oldRevision)
        Write-Host ('Incoming source: ' + $manifest.sourceSha)
        if ((Read-Host 'Confirm this reviewed replacement can read the current journal and is approved for this off-air maintenance window. Type yes to replace, or press Enter to stop') -cne 'yes') { throw 'Replacement not confirmed' }
    }
    if (Test-Path -LiteralPath $lockPath) { throw 'Connector setup lock exists' }
    try { $lock = New-Object IO.FileStream($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch {
        if (Test-Path -LiteralPath $lockPath) { throw 'Connector setup lock exists' }
        throw
    }
    $stage = $null
    $recoveryNeeded = $false
    try {
        Assert-ConnectorStopped $target
        if ((Get-ConnectorInstallSnapshot $target $names) -cne $confirmedSnapshot) { throw 'Installed package changed during confirmation' }
        if ($source -eq $target -or $samePackage) {
            Write-Host 'The installed package is already current. Running its self-test again.'
            [IO.File]::WriteAllText((Join-Path $target 'self-test.pending'), $manifest.sourceSha)
            return $target
        }
        $stage = Join-Path $parent ('vmix-agent-incoming-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stage | Out-Null
        foreach ($name in $script:connectorPackageNames + @('runtime')) {
            Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $stage $name) -Recurse
        }
        $stagedManifest = Get-ConnectorPackage $stage
        if (($stagedManifest | ConvertTo-Json -Depth 5 -Compress) -cne ($manifest | ConvertTo-Json -Depth 5 -Compress)) { throw 'Incoming package changed during setup' }
        $record = [ordered]@{schemaVersion=1; sourceSha=$manifest.sourceSha; installedAtUtc=[DateTime]::UtcNow.ToString('o'); files=$manifest.files}
        [IO.File]::WriteAllText((Join-Path $stage 'install-record.json'), ($record | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText((Join-Path $stage 'self-test.pending'), $manifest.sourceSha)
        $backup = Join-Path $parent ('vmix-agent-previous-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
        $saved = @(); $installed = @()
        try {
            Assert-ConnectorStopped $target
            if ($existing.Count) { New-Item -ItemType Directory -Path $backup | Out-Null }
            # Remove the legacy executable first; restore it only after every
            # other entry is restored. Old launchers cannot run a mixed install.
            $existing = @($existing | Where-Object { $_ -eq 'vmix-agent.cjs' }) + @($existing | Where-Object { $_ -ne 'vmix-agent.cjs' })
            foreach ($name in $existing) {
                Move-Item -LiteralPath (Join-Path $target $name) -Destination (Join-Path $backup $name)
                $saved += $name
            }
            New-Item -ItemType Directory -Path $target -Force | Out-Null
            $installNames = @($names | Where-Object { $_ -ne 'vmix-agent.cjs' }) + @('vmix-agent.cjs')
            foreach ($name in $installNames) {
                Move-Item -LiteralPath (Join-Path $stage $name) -Destination (Join-Path $target $name)
                $installed += $name
            }
        } catch {
            # Put only our moved package entries back; never touch user state.
            # Attempt every entry even if antivirus or a file handle blocks one.
            foreach ($name in $installed) {
                try { Move-Item -LiteralPath (Join-Path $target $name) -Destination (Join-Path $stage $name) }
                catch { $recoveryNeeded = $true }
            }
            foreach ($name in @($saved | Where-Object { $_ -ne 'vmix-agent.cjs' })) {
                try { Move-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $target $name) }
                catch { $recoveryNeeded = $true }
            }
            if (-not $recoveryNeeded -and 'vmix-agent.cjs' -in $saved) {
                try { Move-Item -LiteralPath (Join-Path $backup 'vmix-agent.cjs') -Destination (Join-Path $target 'vmix-agent.cjs') }
                catch { $recoveryNeeded = $true }
            }
            if ($recoveryNeeded) {
                Write-Host ('STOP: Recovery is required. Keep the setup lock. Previous files: ' + $backup)
                Write-Host ('Incoming files: ' + $stage)
                throw 'Connector install needs recovery'
            }
            throw
        }
        if ($existing.Count) { Write-Host ('Previous package kept in ' + $backup) }
        # Only unblock newly installed package files, never credentials/config/journals.
        foreach ($relative in @($manifest.files.PSObject.Properties.Name) + @('package-files.json')) {
            Unblock-File -LiteralPath (Join-Path $target $relative)
        }
        return $target
    } finally {
        $lock.Dispose()
        if (-not $recoveryNeeded) { Remove-Item -LiteralPath $lockPath }
        # Keep an incomplete staging directory for recovery; remove only an empty one.
        if ($stage -and (Test-Path -LiteralPath $stage) -and @(Get-ChildItem -LiteralPath $stage -Force).Count -eq 0) { Remove-Item -LiteralPath $stage }
    }
}
