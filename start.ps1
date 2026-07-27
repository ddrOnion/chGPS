<#
  chGPS one-shot launcher.

  Starts tunneld + bridge + dev server, then blocks. Every child is placed in a
  Windows Job Object created with KILL_ON_JOB_CLOSE, so the whole group dies
  with this process — Ctrl+C, closing the window, or being killed outright.
  Handler-based cleanup alone would not survive the window's X button.

  tunneld needs a TUN interface, so the script elevates itself if needed.
  Interpreter paths are resolved *before* elevating and passed through: python
  often lives under the invoking user's profile, which an elevated session
  running as a different admin account cannot see on its PATH.
#>

param(
    [string]$PythonExe,
    [string]$NodeExe,
    [string]$NpmCmd,
    [switch]$SkipDepCheck
)

$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$LogDir = Join-Path $Root 'logs'

# Keep the window readable when something fails; an elevated console vanishes
# the moment the script ends, taking the error with it.
function Stop-WithMessage {
    param([string]$Message, [string]$Detail)

    Write-Host ""
    Write-Host "  $Message" -ForegroundColor Red
    if ($Detail) {
        Write-Host ""
        foreach ($line in ($Detail -split "`n")) {
            Write-Host "    $($line.TrimEnd())" -ForegroundColor DarkGray
        }
    }
    Write-Host ""
    Write-Host "  按 Enter 關閉..." -ForegroundColor DarkGray
    [void](Read-Host)
    exit 1
}

# --- Resolve interpreters (pre-elevation) ----------------------------------

function Resolve-Tool {
    param([string]$Provided, [string]$Name)

    if ($Provided -and (Test-Path $Provided)) { return $Provided }

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

$PythonExe = Resolve-Tool $PythonExe 'python'
$NodeExe = Resolve-Tool $NodeExe 'node'
$NpmCmd = Resolve-Tool $NpmCmd 'npm.cmd'

$missing = @()
if (-not $PythonExe) { $missing += 'python' }
if (-not $NodeExe) { $missing += 'node' }
if (-not $NpmCmd) { $missing += 'npm' }

if ($missing.Count) {
    Stop-WithMessage "找不到必要工具: $($missing -join ', ')" `
        "請確認它們在 PATH 上，或直接指定：`n  .\start.ps1 -PythonExe C:\path\to\python.exe"
}

# --- Dependencies (pre-elevation) ------------------------------------------
# Installed before elevating on purpose: python usually lives in the invoking
# user's profile, and a node_modules tree written by an elevated session can end
# up owned by a different account. Both checks are no-ops once satisfied, so the
# normal path costs one Test-Path sweep plus one short python startup.

function Get-MissingNodePackages {
    $manifest = Join-Path $Root 'package.json'
    if (-not (Test-Path $manifest)) { return @() }

    $modules = Join-Path $Root 'node_modules'
    if (-not (Test-Path $modules)) { return @('node_modules') }

    # Top-level dirs only. A partial tree (interrupted install, deleted folder)
    # is the case worth catching; npm itself resolves the transitive graph.
    $deps = (Get-Content $manifest -Raw | ConvertFrom-Json).dependencies
    if (-not $deps) { return @() }

    @($deps.PSObject.Properties.Name | Where-Object {
        -not (Test-Path (Join-Path $modules $_))
    })
}

function Test-PythonModule {
    param([string]$Name)

    # find_spec locates the package without importing it — pymobiledevice3 pulls
    # in a heavy dependency graph, and this check runs on every launch.
    & $PythonExe -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('$Name') else 1)" 2>$null
    return ($LASTEXITCODE -eq 0)
}

if (-not $SkipDepCheck) {
    Push-Location $Root
    try {
        $needNode = Get-MissingNodePackages
        if ($needNode.Count) {
            Write-Host "缺少 npm 套件（$($needNode -join ', ')），正在安裝..." -ForegroundColor Yellow
            & $NpmCmd install
            if ($LASTEXITCODE -ne 0) {
                Stop-WithMessage "npm install 失敗 (exit $LASTEXITCODE)" `
                    "請手動在專案目錄執行：`n  npm install"
            }
            Write-Host "npm 套件安裝完成" -ForegroundColor Green
        }

        if (-not (Test-PythonModule 'pymobiledevice3')) {
            Write-Host "缺少 pymobiledevice3，正在安裝..." -ForegroundColor Yellow
            & $PythonExe -m pip install pymobiledevice3

            # A system-wide Python (Program Files) is not writable without admin;
            # --user lands in the profile, which is where we want it anyway.
            if ($LASTEXITCODE -ne 0) {
                Write-Host "改以 --user 重試..." -ForegroundColor Yellow
                & $PythonExe -m pip install --user pymobiledevice3
            }

            if (-not (Test-PythonModule 'pymobiledevice3')) {
                Stop-WithMessage "pymobiledevice3 安裝失敗" `
                    "請手動執行：`n  $PythonExe -m pip install pymobiledevice3"
            }
            Write-Host "pymobiledevice3 安裝完成" -ForegroundColor Green
        }
    } finally {
        Pop-Location
    }
}

# --- Elevate ---------------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "需要系統管理員權限（tunneld 要建立 TUN 介面），正在提升..." -ForegroundColor Yellow

    # Hand the resolved paths over — the elevated session may not share this
    # user's PATH, and re-resolving there is exactly what used to fail.
    # -SkipDepCheck: deps were just handled as the invoking user.
    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $PSCommandPath),
        '-PythonExe', ('"{0}"' -f $PythonExe),
        '-NodeExe', ('"{0}"' -f $NodeExe),
        '-NpmCmd', ('"{0}"' -f $NpmCmd),
        '-SkipDepCheck'
    )

    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
    } catch {
        Stop-WithMessage "提權失敗（UAC 被取消？）" $_.Exception.Message
    }
    exit
}

# --- Everything below runs elevated ----------------------------------------

$ErrorActionPreference = 'Stop'
$script:Children = @()

try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

    # --- Job Object --------------------------------------------------------

    if (-not ('ChGps.JobObject' -as [type])) {
        Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;

namespace ChGps {
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public UInt64 ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public UInt64 ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  public static class JobObject {
    const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr a, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoType, IntPtr info, uint cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static IntPtr _handle = IntPtr.Zero;

    /// Creates the job and marks it kill-on-close. Safe to call repeatedly.
    public static void Create() {
      if (_handle != IntPtr.Zero) return;
      _handle = CreateJobObject(IntPtr.Zero, null);

      var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

      int len = Marshal.SizeOf(ext);
      IntPtr ptr = Marshal.AllocHGlobal(len);
      try {
        Marshal.StructureToPtr(ext, ptr, false);
        if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformation, ptr, (uint)len))
          throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
      } finally {
        Marshal.FreeHGlobal(ptr);
      }
    }

    public static bool Add(IntPtr processHandle) {
      if (_handle == IntPtr.Zero) Create();
      return AssignProcessToJobObject(_handle, processHandle);
    }
  }
}
'@
    }

    [ChGps.JobObject]::Create()

    # --- Helpers -----------------------------------------------------------

    function Start-Child {
        param([string]$Name, [string]$File, [string[]]$Arguments)

        $log = Join-Path $LogDir "$Name.log"
        $err = Join-Path $LogDir "$Name.err"

        try {
            $p = Start-Process -FilePath $File -ArgumentList $Arguments `
                -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput $log -RedirectStandardError $err
        } catch {
            Stop-WithMessage "無法啟動 $Name" "$File`n$($_.Exception.Message)"
        }

        if (-not [ChGps.JobObject]::Add($p.Handle)) {
            Write-Host "  ! 無法將 $Name 加入 job object，關閉視窗時可能殘留" -ForegroundColor Yellow
        }

        $script:Children += [pscustomobject]@{ Name = $Name; Process = $p; Log = $log; Err = $err }
        return $p
    }

    function Wait-Until {
        param([scriptblock]$Test, [int]$TimeoutSec = 60, [System.Diagnostics.Process]$Watch)

        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $deadline) {
            # A child that already died will never pass the test — fail fast.
            if ($Watch -and $Watch.HasExited) { return $false }
            try { if (& $Test) { return $true } } catch { }
            Start-Sleep -Milliseconds 700
        }
        return $false
    }

    function Test-Http {
        param([string]$Url, [int]$TimeoutSec = 3)
        try {
            $null = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing
            return $true
        } catch {
            return $false
        }
    }

    function Show-Failure {
        param([string]$Name)
        $entry = $script:Children | Where-Object { $_.Name -eq $Name } | Select-Object -Last 1
        Write-Host " 失敗" -ForegroundColor Red
        foreach ($f in @($entry.Err, $entry.Log)) {
            if ($f -and (Test-Path $f) -and (Get-Item $f).Length -gt 0) {
                Get-Content $f -Tail 6 | ForEach-Object {
                    Write-Host "        $_" -ForegroundColor DarkGray
                }
                break
            }
        }
        Write-Host "        完整日誌: $LogDir" -ForegroundColor DarkGray
    }

    function Clear-StrayProcesses {
        # A simulate-location process outlives a crashed bridge and keeps holding
        # the device, which makes the next run fail in confusing ways. Sweep first.
        $stray = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'pymobiledevice3.*simulate-location' }

        foreach ($s in $stray) { & taskkill /pid $s.ProcessId /T /F 2>&1 | Out-Null }
        return @($stray).Count
    }

    # --- Banner ------------------------------------------------------------

    Clear-Host
    Write-Host ""
    Write-Host "  chGPS " -ForegroundColor Cyan -NoNewline
    Write-Host "— 地圖選點改 iPhone 定位"
    Write-Host "  ────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""

    $swept = Clear-StrayProcesses
    if ($swept -gt 0) {
        Write-Host "  清理殘留的 simulate-location 行程 x$swept（iPhone 定位已還原）" -ForegroundColor DarkGray
        Write-Host ""
    }

    # --- 1. tunneld --------------------------------------------------------

    Write-Host "  [1/3] RemoteXPC tunneld ..." -NoNewline
    if (Test-Http 'http://127.0.0.1:49151/' 2) {
        Write-Host " 已在執行" -ForegroundColor DarkGray
    } else {
        $t = Start-Child -Name 'tunneld' -File $PythonExe `
            -Arguments @('-m', 'pymobiledevice3', 'remote', 'tunneld')

        if (Wait-Until { Test-Http 'http://127.0.0.1:49151/' 2 } 45 $t) {
            Write-Host " OK" -ForegroundColor Green
        } else {
            Show-Failure 'tunneld'
        }
    }

    # --- 2. bridge ---------------------------------------------------------

    Write-Host "  [2/3] Bridge (:4000)     ..." -NoNewline
    $b = Start-Child -Name 'bridge' -File $NodeExe -Arguments @('server/index.js')

    if (Wait-Until { Test-Http 'http://127.0.0.1:4000/api/status' 20 } 45 $b) {
        Write-Host " OK" -ForegroundColor Green
    } else {
        Show-Failure 'bridge'
    }

    # --- 3. dev server -----------------------------------------------------

    Write-Host "  [3/3] Web UI (:3000)     ..." -NoNewline
    $v = Start-Child -Name 'vite' -File $NpmCmd -Arguments @('run', 'dev')

    if (Wait-Until { Test-Http 'http://127.0.0.1:3000/' 3 } 60 $v) {
        Write-Host " OK" -ForegroundColor Green
    } else {
        Show-Failure 'vite'
    }

    # --- Device summary ----------------------------------------------------

    Write-Host ""
    try {
        $st = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/api/status?fresh=1' -TimeoutSec 90
        if ($st.connected) {
            Write-Host "  裝置  " -NoNewline -ForegroundColor DarkGray
            Write-Host "$($st.device.name) · $($st.device.model) · iOS $($st.device.iosVersion)"
            Write-Host "  狀態  " -NoNewline -ForegroundColor DarkGray
            if ($st.ready) {
                Write-Host "就緒，可傳送定位" -ForegroundColor Green
            } else {
                Write-Host "尚未就緒" -ForegroundColor Yellow
                foreach ($bl in $st.blockers) {
                    Write-Host "        - $($bl.message)" -ForegroundColor Yellow
                }
            }
        } else {
            Write-Host "  裝置  " -NoNewline -ForegroundColor DarkGray
            Write-Host "未偵測到 iPhone（請接上 USB 並解鎖）" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  裝置  無法查詢狀態" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "  ────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host "  http://localhost:3000" -ForegroundColor Cyan
    Write-Host "  日誌 $LogDir" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  關閉此視窗或按 Ctrl+C 會停止所有服務" -ForegroundColor DarkGray
    Write-Host ""

    Start-Process 'http://localhost:3000' | Out-Null

    # --- Supervise ---------------------------------------------------------
    # Job Object handles teardown; this loop only reports a child dying early.

    while ($true) {
        Start-Sleep -Seconds 3
        foreach ($c in $script:Children) {
            if ($c.Process.HasExited -and -not $c.PSObject.Properties['Reported']) {
                Add-Member -InputObject $c -NotePropertyName Reported -NotePropertyValue $true
                Write-Host "  ! $($c.Name) 已結束 (exit $($c.Process.ExitCode)) — 見 $($c.Err)" -ForegroundColor Red
            }
        }
    }
} catch {
    Stop-WithMessage "啟動失敗" "$($_.Exception.Message)`n`n$($_.ScriptStackTrace)"
} finally {
    Write-Host ""
    Write-Host "  停止中..." -ForegroundColor DarkGray
    # Redundant with the Job Object, but makes Ctrl+C teardown immediate.
    foreach ($c in $script:Children) {
        if (-not $c.Process.HasExited) {
            & taskkill /pid $c.Process.Id /T /F 2>&1 | Out-Null
        }
    }
}
