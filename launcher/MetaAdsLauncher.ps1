Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ProjectDir = Join-Path $env:USERPROFILE 'Desktop\meta\memeanji\memeanji\seriesbuilder'
$EnvPath = Join-Path $ProjectDir '.env'

function Show-Message($message, $title = 'Meta Ads Launcher') {
  [System.Windows.Forms.MessageBox]::Show(
    $message,
    $title,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
}

function Show-Error($message) {
  [System.Windows.Forms.MessageBox]::Show(
    $message,
    'Meta Ads Launcher',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Meta Ads Launcher'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(430, 210)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Meta Ads 자동 실행'
$title.Font = New-Object System.Drawing.Font('Malgun Gothic', 15, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(22, 18)
$form.Controls.Add($title)

$pathLabel = New-Object System.Windows.Forms.Label
$pathLabel.Text = "작업 폴더: $ProjectDir"
$pathLabel.Font = New-Object System.Drawing.Font('Malgun Gothic', 9)
$pathLabel.AutoEllipsis = $true
$pathLabel.Size = New-Object System.Drawing.Size(385, 22)
$pathLabel.Location = New-Object System.Drawing.Point(24, 58)
$form.Controls.Add($pathLabel)

$status = New-Object System.Windows.Forms.Label
$status.Text = '실행 전 .env 값을 확인한 뒤 시작하세요.'
$status.Font = New-Object System.Drawing.Font('Malgun Gothic', 9)
$status.Size = New-Object System.Drawing.Size(385, 26)
$status.Location = New-Object System.Drawing.Point(24, 88)
$form.Controls.Add($status)

$runButton = New-Object System.Windows.Forms.Button
$runButton.Text = '실행'
$runButton.Font = New-Object System.Drawing.Font('Malgun Gothic', 10, [System.Drawing.FontStyle]::Bold)
$runButton.Size = New-Object System.Drawing.Size(118, 42)
$runButton.Location = New-Object System.Drawing.Point(26, 135)
$form.Controls.Add($runButton)

$envButton = New-Object System.Windows.Forms.Button
$envButton.Text = '.env 열기'
$envButton.Font = New-Object System.Drawing.Font('Malgun Gothic', 10)
$envButton.Size = New-Object System.Drawing.Size(118, 42)
$envButton.Location = New-Object System.Drawing.Point(156, 135)
$form.Controls.Add($envButton)

$folderButton = New-Object System.Windows.Forms.Button
$folderButton.Text = '폴더 열기'
$folderButton.Font = New-Object System.Drawing.Font('Malgun Gothic', 10)
$folderButton.Size = New-Object System.Drawing.Size(118, 42)
$folderButton.Location = New-Object System.Drawing.Point(286, 135)
$form.Controls.Add($folderButton)

$runButton.Add_Click({
  if (-not (Test-Path $ProjectDir)) {
    Show-Error "작업 폴더를 찾지 못했습니다.`n$ProjectDir"
    return
  }

  if (-not (Test-Path $EnvPath)) {
    Show-Error ".env 파일을 찾지 못했습니다.`n$EnvPath"
    return
  }

  $status.Text = '실행 중입니다. 열린 터미널에서 진행 상황을 확인하세요.'
  $runButton.Enabled = $false

  $command = "Set-Location -LiteralPath '$ProjectDir'; npm run open-campaign"
  Start-Process powershell.exe -ArgumentList @(
    '-NoExit',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $command
  ) -WorkingDirectory $ProjectDir
})

$envButton.Add_Click({
  if (-not (Test-Path $EnvPath)) {
    New-Item -Path $EnvPath -ItemType File -Force | Out-Null
  }
  Start-Process notepad.exe $EnvPath
})

$folderButton.Add_Click({
  if (-not (Test-Path $ProjectDir)) {
    Show-Error "작업 폴더를 찾지 못했습니다.`n$ProjectDir"
    return
  }
  Start-Process explorer.exe $ProjectDir
})

[void]$form.ShowDialog()
