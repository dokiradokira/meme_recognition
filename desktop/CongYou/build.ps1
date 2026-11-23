param([switch]$Test, [switch]$Package)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$repository = (Resolve-Path '../..').Path
$framework = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$cache = New-Item -ItemType Directory -Force '.build/packages'
$output = New-Item -ItemType Directory -Force 'dist'

function Use-Package($Name, $Id, $Version, $Sha256, [string[]]$Members) {
    $archive = Join-Path $cache.FullName "$Name.nupkg"
    $expanded = New-Item -ItemType Directory -Force (Join-Path $cache.FullName $Name)
    if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive).Hash -ne $Sha256) {
        $url = "https://api.nuget.org/v3-flatcontainer/$Id/$Version/$Id.$Version.nupkg"
        curl.exe -fLsS --retry 1 --max-time 180 -o $archive $url
        if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $archive).Hash -ne $Sha256) {
            throw "Cannot download or verify $Id $Version."
        }
    }
    tar.exe -xf $archive -C $expanded.FullName @Members
    if ($LASTEXITCODE -ne 0) { throw "Cannot extract $Id." }
    return $expanded.FullName
}

$sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\UnionMetadata"
$metadata = Get-ChildItem -LiteralPath $sdkRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.' } | Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Get-Item (Join-Path $_.FullName 'Windows.winmd') -ErrorAction SilentlyContinue } | Select-Object -First 1
if (!$metadata) {
    $metadataMember = 'c/UnionMetadata/10.0.26100.0/Windows.winmd'
    $sdk = Use-Package 'windows-sdk' 'microsoft.windows.sdk.cpp' '10.0.26100.3916' `
        '21DFB5DB3397425EE428E0FD54CEDC51AF52DDD10C82433A7CDB483ECBB284AD' @($metadataMember)
    $metadata = Get-Item (Join-Path $sdk $metadataMember)
}

$members = @('lib/net462/Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll',
    'build/native/x64/WebView2Loader.dll','LICENSE.txt','NOTICE.txt')
$webview = Use-Package 'webview2' 'microsoft.web.webview2' '1.0.3650.58' `
    '911A472128C82AC8BAA0C486C23342CC9DD6E7DC50D754E676726642CA065C60' $members
foreach ($member in $members[0..2]) { Copy-Item -LiteralPath (Join-Path $webview $member) -Destination $output.FullName }
Copy-Item -LiteralPath (Join-Path $webview 'LICENSE.txt') -Destination (Join-Path $output.FullName 'WebView2-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $webview 'NOTICE.txt') -Destination (Join-Path $output.FullName 'WebView2-NOTICE.txt')

$runtimeFacade = Get-ChildItem "$env:WINDIR\Microsoft.NET\assembly\GAC_MSIL\System.Runtime" -Recurse -Filter System.Runtime.dll |
    Where-Object { [Reflection.AssemblyName]::GetAssemblyName($_.FullName).Version -eq [version]'4.0.0.0' } | Select-Object -First 1
if (!$runtimeFacade) { throw 'Install .NET Framework 4.8.' }

Push-Location $repository
try {
    if (!(Test-Path -LiteralPath 'node_modules/vite/bin/vite.js')) {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    node scripts/model.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare the local pose model.' }
    node scripts/build-desktop-pose.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Cannot build the pose engine.' }
    $assets = New-Item -ItemType Directory -Force (Join-Path $output.FullName 'pose-assets')
    Copy-Item -LiteralPath 'src/memes.json' -Destination $assets.FullName
    Copy-Item -LiteralPath 'public/memes' -Destination $assets.FullName -Recurse -Force
    Copy-Item -LiteralPath 'public/MediaPipe-LICENSE.txt' -Destination $output.FullName
    $local = New-Item -ItemType Directory -Force (Join-Path $assets.FullName 'local-memes')
    $localArt = Join-Path $local.FullName 'thinking-meme.jpg'
    if (Test-Path -LiteralPath 'local-memes/thinking-meme.jpg') {
        Copy-Item -LiteralPath 'local-memes/thinking-meme.jpg' -Destination $localArt
    } elseif (Test-Path -LiteralPath $localArt) {
        Remove-Item -LiteralPath $localArt
    }
} finally { Pop-Location }
Copy-Item -LiteralPath 'README.md' -Destination $output.FullName

$options = @('/nologo','/codepage:65001','/optimize+','/platform:x64','/define:TRACE',
    "/r:$($metadata.FullName)", "/r:$framework\System.Runtime.WindowsRuntime.dll",
    "/r:$framework\System.Runtime.InteropServices.WindowsRuntime.dll", "/r:$($runtimeFacade.FullName)",
    '/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',
    "/r:$($output.FullName)\Microsoft.Web.WebView2.Core.dll", "/r:$($output.FullName)\Microsoft.Web.WebView2.WinForms.dll")
$sources = @(Get-ChildItem src\*.cs | ForEach-Object FullName)
& "$framework\csc.exe" @options /target:winexe "/out:$($output.FullName)\CongYou.exe" @sources
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Test) {
    $testExe = Join-Path $output.FullName ('CongYou-check-' + [guid]::NewGuid().ToString('N') + '.exe')
    try {
        $testSources = @(Get-ChildItem tests\*.cs | ForEach-Object FullName)
        & "$framework\csc.exe" @options /target:exe /main:CongYou.Checks "/out:$testExe" @sources @testSources
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & $testExe
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        if (Test-Path -LiteralPath $testExe) { Remove-Item -LiteralPath $testExe }
    }
}

if ($Package) {
    $archivePath = Join-Path (Resolve-Path '.build').Path 'CongYou-Windows-x64.zip'
    $files = @('CongYou.exe','README.md','pose-engine','pose-assets','MediaPipe-LICENSE.txt','WebView2-LICENSE.txt',
        'WebView2-NOTICE.txt','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll')
    tar.exe -a -cf $archivePath -C $output.FullName @files
    if ($LASTEXITCODE -ne 0) { throw 'Cannot package CongYou.' }
    Write-Output $archivePath
}
