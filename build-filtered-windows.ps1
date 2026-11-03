$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-LastExitCode([string]$Step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

Push-Location $repoRoot
try {
    $nodeVersionText = (& node --version 2>&1 | Out-String).Trim()
    Assert-LastExitCode "Checking Node.js"
    if ($nodeVersionText -notmatch '^v(?<version>\d+\.\d+\.\d+)') {
        throw "Could not parse Node.js version: $nodeVersionText"
    }
    if ([version]$Matches.version -lt [version]"24.0.0") {
        throw "Node.js 24 or newer is required. Found $nodeVersionText."
    }

    $goVersionText = (& go version 2>&1 | Out-String).Trim()
    Assert-LastExitCode "Checking Go"
    if ($goVersionText -notmatch 'go(?<version>\d+\.\d+\.\d+)') {
        throw "Could not parse Go version: $goVersionText"
    }
    if ([version]$Matches.version -lt [version]"1.26.5") {
        throw "Go 1.26.5 or newer is required. Found $goVersionText."
    }

    Push-Location (Join-Path $repoRoot "ui")
    try {
        & npm.cmd ci
        Assert-LastExitCode "Installing UI dependencies"
        & npm.cmd run build
        Assert-LastExitCode "Building UI"
    }
    finally {
        Pop-Location
    }

    $embeddedDist = Join-Path $repoRoot "engine\internal\webui\dist"
    if (Test-Path $embeddedDist) {
        Remove-Item $embeddedDist -Recurse -Force
    }
    New-Item -ItemType Directory -Path $embeddedDist -Force | Out-Null
    Copy-Item -Path (Join-Path $repoRoot "ui\dist\*") -Destination $embeddedDist -Recurse -Force

    Push-Location (Join-Path $repoRoot "engine")
    try {
        & go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@v1.7.0 `
            -64 -arm=false -icon cmd/etape/assets/etape.ico `
            -o cmd/etape/etape_windows_amd64.syso cmd/etape/versioninfo.json
        Assert-LastExitCode "Generating Windows icon resource"

        $previousGOOS = $env:GOOS
        $previousGOARCH = $env:GOARCH
        $previousCGO = $env:CGO_ENABLED
        try {
            $env:GOOS = "windows"
            $env:GOARCH = "amd64"
            $env:CGO_ENABLED = "0"
            $outputDir = Join-Path $repoRoot "dist"
            New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
            $outputExe = Join-Path $outputDir "etape-windows-amd64.exe"
            & go build -tags "embed_ui tray" `
                -ldflags "-s -w -H=windowsgui -X github.com/earlisreal/eTape/engine/internal/buildinfo.Version=stage3-filtered-candles" `
                -o $outputExe ./cmd/etape
            Assert-LastExitCode "Building Windows executable"
        }
        finally {
            if ($null -eq $previousGOOS) { Remove-Item Env:GOOS -ErrorAction SilentlyContinue } else { $env:GOOS = $previousGOOS }
            if ($null -eq $previousGOARCH) { Remove-Item Env:GOARCH -ErrorAction SilentlyContinue } else { $env:GOARCH = $previousGOARCH }
            if ($null -eq $previousCGO) { Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue } else { $env:CGO_ENABLED = $previousCGO }
        }
    }
    finally {
        Pop-Location
    }

    Write-Host "Build complete: $(Join-Path $repoRoot 'dist\etape-windows-amd64.exe')" -ForegroundColor Green
}
finally {
    Pop-Location
}
