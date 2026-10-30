# kcoder installer for Windows 10 and 11. No terminal experience needed.
#
# One line in PowerShell does it all:
#
#   irm https://raw.githubusercontent.com/kjniedz/kcoder/main/install.ps1 | iex
#
# or, from a downloaded copy of the repo (green "Code" button, Download ZIP,
# unzip), right-click install.ps1 and choose "Run with PowerShell", or:
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# What it does: installs Git and Python with winget if they are missing, makes
# a git checkout of kcoder (cloning it to ~\kcoder when run from a ZIP or the
# pipe, so `kcoder update` can pull new commits), installs
# kcoder into its own Python environment, puts the `kcoder` command on your
# PATH, adds kcoder to the Start Menu and Desktop, and opens the app.
#
# Environment overrides: KCODER_HOME (where to clone, default ~\kcoder),
# KCODER_REPO (clone URL), KCODER_NO_LAUNCH=1 (do not open the app at the end).

$ErrorActionPreference = 'Continue'   # native tools write progress to stderr; exit codes are checked instead
$ProgressPreference = 'SilentlyContinue'

function Say($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) {
    Write-Host ""; Write-Host $msg -ForegroundColor Red
    # pasted into a terminal (irm | iex) there is no file: stop the script, keep the window
    if (-not $PSCommandPath) { throw 'kcoder was not installed' }
    if (-not $env:KCODER_NO_LAUNCH) { Read-Host "Press Enter to close" }
    exit 1
}
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Winget-Install($id, $what) {
    if (-not (Has 'winget')) { Fail "$what is not installed and winget is not available. Install $what yourself, then run this again." }
    Say "Installing $what"
    winget install --id $id -e --source winget --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
}

$repo = if ($env:KCODER_REPO) { $env:KCODER_REPO } else { 'https://github.com/kjniedz/kcoder.git' }

# --- Git ---------------------------------------------------------------
if (-not (Has 'git')) { Winget-Install 'Git.Git' 'Git' }
if (-not (Has 'git')) { Fail 'Git did not install. Install it from https://git-scm.com/download/win and run this again.' }

# --- Python 3.11+ -------------------------------------------------------
function Find-Python {
    foreach ($v in '3.13', '3.12', '3.11', '3.14') {
        if (Has 'py') {
            $p = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() }
        }
    }
    foreach ($dir in @("$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles\Python")) {
        foreach ($v in '313', '312', '311', '314') {
            $p = Join-Path $dir "Python$v\python.exe"
            if (Test-Path $p) { return $p }
        }
    }
    if (Has 'python') {
        $p = & python -c "import sys; print(sys.executable if sys.version_info >= (3, 11) else '')" 2>$null
        if ($LASTEXITCODE -eq 0 -and $p -and $p -notmatch 'WindowsApps') { return $p.Trim() }
    }
    return $null
}
$py = Find-Python
if (-not $py) {
    Winget-Install 'Python.Python.3.13' 'Python 3.13'
    $py = Find-Python
}
if (-not $py) { Fail 'Python did not install. Install Python 3.13 from https://www.python.org/downloads/windows/ and run this again.' }
Say "Using Python at $py"

# --- the kcoder checkout --------------------------------------------------
$here = $PSScriptRoot
if ($here -and (Test-Path (Join-Path $here '.git')) -and (Test-Path (Join-Path $here 'kcoder\cli.py'))) {
    $checkout = $here
    Say "Using this kcoder checkout: $checkout"
} else {
    $checkout = if ($env:KCODER_HOME) { $env:KCODER_HOME } else { Join-Path $HOME 'kcoder' }
    if (Test-Path (Join-Path $checkout '.git')) {
        Say "Updating the kcoder checkout in $checkout"
        git -C $checkout pull --ff-only
    } else {
        Say "Downloading kcoder into $checkout"
        git clone $repo $checkout
        if ($LASTEXITCODE -ne 0) { Fail "Could not clone $repo. Check your internet connection and run this again." }
    }
}

# --- install into its own environment ------------------------------------
$venv = Join-Path $env:LOCALAPPDATA 'Programs\kcoder\venv'
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    Say "Creating kcoder's Python environment in $venv"
    & $py -m venv $venv
    if ($LASTEXITCODE -ne 0) { Fail 'Could not create the Python environment.' }
}
$vpy = Join-Path $venv 'Scripts\python.exe'
Say 'Installing kcoder (this takes a minute)'
& $vpy -m pip install --quiet --upgrade pip
& $vpy -m pip install --quiet -e "$checkout[windows]"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'The terminal-view extra did not install; installing kcoder without it.' -ForegroundColor Yellow
    & $vpy -m pip install --quiet -e "$checkout"
    if ($LASTEXITCODE -ne 0) { Fail 'pip could not install kcoder. See the messages above.' }
}

# --- put `kcoder` on PATH --------------------------------------------------
$scripts = Join-Path $venv 'Scripts'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $scripts) {
    Say 'Adding kcoder to your PATH'
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $scripts).TrimStart(';'), 'User')
}
if (($env:Path -split ';') -notcontains $scripts) { $env:Path = "$scripts;$env:Path" }

& (Join-Path $scripts 'kcoder.exe') --version
if ($LASTEXITCODE -ne 0) { Fail 'kcoder installed but does not start. See the messages above.' }

# --- Start Menu + Desktop, then open it ------------------------------------
Say 'Adding kcoder to the Start Menu and Desktop'
& (Join-Path $scripts 'kcoder.exe') app --install

Write-Host ''
Write-Host 'Done. Open kcoder from the Start Menu or Desktop, or type  kcoder app  in a NEW terminal window.' -ForegroundColor Green
Write-Host '(Terminals that were already open do not see the new PATH until you open a new one.)'
if (-not $env:KCODER_NO_LAUNCH) {
    & (Join-Path $scripts 'kcoder.exe') app
}
