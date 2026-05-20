$Root = Split-Path -Parent $PSScriptRoot
$LauncherDir = $PSScriptRoot
$SedPath = Join-Path $LauncherDir 'MetaAdsLauncher.sed'
$OutputExe = Join-Path $Root 'MetaAdsLauncher.exe'
$LaunchCmd = Join-Path $LauncherDir 'launch.cmd'
$LauncherPs1 = Join-Path $LauncherDir 'MetaAdsLauncher.ps1'
$BuildDir = 'C:\Users\Public\MetaAdsLauncherBuild'
$BuildOutputExe = Join-Path $BuildDir 'MetaAdsLauncher.exe'

New-Item -Path $BuildDir -ItemType Directory -Force | Out-Null
Copy-Item -Path $LaunchCmd -Destination (Join-Path $BuildDir 'launch.cmd') -Force
Copy-Item -Path $LauncherPs1 -Destination (Join-Path $BuildDir 'MetaAdsLauncher.ps1') -Force

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$BuildOutputExe
FriendlyName=Meta Ads Launcher
AppLaunched=launch.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$BuildDir
[SourceFiles0]
%FILE0%=
%FILE1%=
[Strings]
FILE0=launch.cmd
FILE1=MetaAdsLauncher.ps1
"@

if (-not (Test-Path $LaunchCmd)) {
  throw "launch.cmd 파일을 찾지 못했습니다: $LaunchCmd"
}

if (-not (Test-Path $LauncherPs1)) {
  throw "MetaAdsLauncher.ps1 파일을 찾지 못했습니다: $LauncherPs1"
}

Set-Content -Path $SedPath -Value $sed -Encoding ASCII
& iexpress.exe /N /Q $SedPath

for ($i = 0; $i -lt 20 -and -not (Test-Path $BuildOutputExe); $i += 1) {
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Path $BuildOutputExe)) {
  throw "EXE 생성 실패: $BuildOutputExe"
}

Copy-Item -Path $BuildOutputExe -Destination $OutputExe -Force
Write-Host "EXE 생성 완료: $OutputExe"
