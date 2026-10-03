# End-to-end test of the Windows self-installer, as a user would experience it:
# zip downloaded from the internet (Mark of the Web) -> Extract All -> run Dial TV.exe -> Install ->
# launch installed copy -> update over it -> uninstall. Uses isolated install/shortcut/registry
# locations so a real installation is never touched. Fails on any Smart App Control block.
param([string]$Zip = (Get-ChildItem "$PSScriptRoot\..\..\release\Dial-TV-*-win.zip" | Select-Object -First 1).FullName)
$ErrorActionPreference = 'Stop'
$t0 = Get-Date
$work = Join-Path $env:TEMP "dialtv-install-test"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $work | Out-Null
$fail = @()
function Check($ok, $what) { if ($ok) { "PASS  $what" } else { "FAIL  $what"; $script:fail += $what } }

# 1. "Download" + Extract All: copy the zip, mark it as from the internet, extract (Explorer propagates MOTW).
Copy-Item $Zip "$work\download.zip"
Set-Content "$work\download.zip" -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=https://github.com/"
Expand-Archive "$work\download.zip" "$work\extracted"
Get-ChildItem "$work\extracted" -Recurse -File | ForEach-Object { Set-Content $_.FullName -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3" }
Check (Test-Path "$work\extracted\READ ME FIRST.txt") "zip contains READ ME FIRST.txt"

$env:DIAL_INSTALL_ROOT = "$work\Programs\Dial TV"
$env:DIAL_SHORTCUT_DIR = "$work\shortcuts"
$env:DIAL_UNINSTALL_KEY = "DialTV-InstallTest"
$env:DIAL_PROFILE = "installtest"
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DialTV-InstallTest"

# 2. Run the extracted app and install.
$p = Start-Process "$work\extracted\Dial TV.exe" -ArgumentList '--install', '--silent', '--no-launch' -PassThru -Wait
$exe = "$env:DIAL_INSTALL_ROOT\Dial TV.exe"
Check (Test-Path $exe) "installed to Programs\Dial TV"
Check ((Get-FileHash $exe).Hash -eq (Get-FileHash "$PSScriptRoot\..\..\node_modules\electron\dist\electron.exe").Hash) "installed Dial TV.exe is byte-identical to stock Electron"
Check (Test-Path "$env:DIAL_INSTALL_ROOT\resources\ffmpeg\ffmpeg.exe") "built-in decoder (ffmpeg) installed"
$sh = New-Object -ComObject WScript.Shell
foreach ($d in 'Start Menu', 'Desktop') {
  $lnk = "$env:DIAL_SHORTCUT_DIR\$d\Dial TV.lnk"
  Check ((Test-Path $lnk) -and ($sh.CreateShortcut($lnk).TargetPath -eq $exe)) "$d shortcut points at installed app"
  if (Test-Path $lnk) { Check ($sh.CreateShortcut($lnk).IconLocation -like '*icon.ico*') "$d shortcut uses the Dial TV icon" }
}
$r = Get-ItemProperty $key -ErrorAction SilentlyContinue
Check ($r -and $r.DisplayName -eq 'Dial TV' -and $r.UninstallString -like '*--uninstall*' -and $r.InstallLocation -eq $env:DIAL_INSTALL_ROOT) "Installed-apps entry registered (name, uninstall command, location)"
"      version $($r.DisplayVersion), size $([math]::Round($r.EstimatedSize/1024)) MB"

# 3. Launch the installed app like the shortcut does.
$app = Start-Process $exe -PassThru
Start-Sleep 15
$alive = -not $app.HasExited -and (Get-Process -Id $app.Id -ErrorAction SilentlyContinue).MainWindowTitle -eq 'Dial TV'
Check $alive "installed app launches and shows its window"
Get-CimInstance Win32_Process -Filter "Name='Dial TV.exe'" | Where-Object { $_.ExecutablePath -like "$work*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 2

# 4. Update: run the (re-extracted) zip copy again over the installed one.
Start-Process "$work\extracted\Dial TV.exe" -ArgumentList '--install', '--silent', '--no-launch' -Wait
Check ((Test-Path $exe) -and (Get-ItemProperty $key -ErrorAction SilentlyContinue)) "update over an existing install works"

# 5. Uninstall the way Windows Settings does.
Start-Process $exe -ArgumentList '--uninstall', '--silent' -Wait
Start-Sleep 6
Check (-not (Test-Path $env:DIAL_INSTALL_ROOT)) "uninstall removes the app folder"
Check (-not (Test-Path "$env:DIAL_SHORTCUT_DIR\Start Menu\Dial TV.lnk") -and -not (Test-Path "$env:DIAL_SHORTCUT_DIR\Desktop\Dial TV.lnk")) "uninstall removes shortcuts"
Check (-not (Test-Path $key)) "uninstall removes the Installed-apps entry"

# 6. Smart App Control must not have blocked anything during the run.
$blocks = Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 500 -ErrorAction SilentlyContinue |
  Where-Object { $_.TimeCreated -gt $t0 -and $_.Id -in 3033, 3077 }
Check ($blocks.Count -eq 0) "no Smart App Control blocks ($($blocks.Count))"
$blocks | Select-Object -First 3 | ForEach-Object { "      " + ([regex]::Match($_.Message, 'load (.+?) that')).Groups[1].Value }

Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
if ($fail.Count) { "`n$($fail.Count) FAILED"; exit 1 } else { "`nALL INSTALL TESTS PASSED" }
