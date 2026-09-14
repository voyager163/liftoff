<#
.SYNOPSIS
    Liftoff Windows Job Object Process Controller
.DESCRIPTION
    Manages process-tree execution on Windows using genuine Win32 Job Objects.
    Enforces atomic process-job assignment, handle restriction, length-prefixed control pipe protocol,
    and kernel ActiveProcesses accounting for settlement proof.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ControlPipeName,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedNonce,

    [Parameter(Mandatory = $true)]
    [string]$WorkspaceId,

    [Parameter(Mandatory = $true)]
    [string]$InvocationId
)

$ErrorActionPreference = 'Stop'

# Define Win32 interop for Job Objects and CreateProcessW with STARTUPINFOEX
$win32TypeDef = @"
using System;
using System.Runtime.InteropServices;

public static class Win32JobNative {
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    public const int JobObjectExtendedLimitInformation = 9;
    public const int JobObjectBasicAccountingInformation = 1;

    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    public const uint CREATE_SUSPENDED = 0x00000004;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    public const uint PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    public const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;

    public const uint WAIT_OBJECT_0 = 0x00000000;
    public const uint WAIT_TIMEOUT = 0x00000102;
    public const uint WAIT_FAILED = 0xFFFFFFFF;
    public const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryLimit;
        public UIntPtr PeakJobMemoryLimit;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool QueryInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength,
        out uint lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, [MarshalAs(UnmanagedType.Bool)] out bool Result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool InitializeProcThreadAttributeList(
        IntPtr lpAttributeList,
        int dwAttributeCount,
        int dwFlags,
        ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr Attribute,
        IntPtr lpValue,
        IntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteProcThreadAttributeList(IntPtr lpAttributeList);
}
"@

try {
    Add-Type -TypeDefinition $win32TypeDef -ErrorAction Stop
} catch {
    Write-Error "Failed to load Win32 Job API definitions. Check LanguageMode and ExecutionPolicy: $_"
    exit 1
}

# Connect to the private control pipe
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $ControlPipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None)
try {
    $pipe.Connect(30000)
} catch {
    Write-Error "Failed to connect to control pipe $ControlPipeName : $_"
    exit 1
}

function Send-ControlFrame($stream, $obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 10
    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $len = $payloadBytes.Length
    $header = New-Object byte[] 4
    $header[0] = [byte](($len -shr 24) -band 0xFF)
    $header[1] = [byte](($len -shr 16) -band 0xFF)
    $header[2] = [byte](($len -shr 8) -band 0xFF)
    $header[3] = [byte]($len -band 0xFF)
    $stream.Write($header, 0, 4)
    $stream.Write($payloadBytes, 0, $len)
    $stream.Flush()
}

function Read-ControlFrame($stream) {
    $header = New-Object byte[] 4
    $read = 0
    while ($read -lt 4) {
        $n = $stream.Read($header, $read, 4 - $read)
        if ($n -le 0) { return $null }
        $read += $n
    }
    $len = ($header[0] -shl 24) -bor ($header[1] -shl 16) -bor ($header[2] -shl 8) -bor $header[3]
    if ($len -le 0 -or $len -gt 65536) {
        throw "Invalid control frame length: $len"
    }
    $payload = New-Object byte[] $len
    $read = 0
    while ($read -lt $len) {
        $n = $stream.Read($payload, $read, $len - $read)
        if ($n -le 0) { return $null }
        $read += $n
    }
    $json = [System.Text.Encoding]::UTF8.GetString($payload)
    return $json | ConvertFrom-Json
}

$hJob = [IntPtr]::Zero
$pi = New-Object Win32JobNative+PROCESS_INFORMATION
$attributeList = [IntPtr]::Zero
$pJobHandle = [IntPtr]::Zero
$pExtendedInfo = [IntPtr]::Zero
$pAccounting = [IntPtr]::Zero

try {
    # Read the spawn request from the parent
    $req = Read-ControlFrame $pipe
    if ($null -eq $req) {
        throw "Parent closed control pipe before sending spawn request."
    }

    # Validate incoming spawn request
    if ($req.schemaVersion -ne 1 -or $req.kind -ne 'spawn' -or
        $req.nonce -ne $ExpectedNonce -or
        $req.workspaceId -ne $WorkspaceId -or
        $req.invocationId -ne $InvocationId -or
        $req.sequence -ne 1) {

        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = "Spawn request validation failed: mismatched scope, nonce, or sequence."
        }
        exit 1
    }

    # Create unnamed non-inheritable Job Object
    $hJob = [Win32JobNative]::CreateJobObject([IntPtr]::Zero, $null)
    if ($hJob -eq [IntPtr]::Zero) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = "CreateJobObject failed with Win32 error $err"
        }
        exit 1
    }

    # Set JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE on the Job
    $extendedInfo = New-Object Win32JobNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $extendedInfo.BasicLimitInformation.LimitFlags = [Win32JobNative]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    $sizeExtended = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32JobNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
    $pExtendedInfo = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($sizeExtended)
    [System.Runtime.InteropServices.Marshal]::StructureToPtr($extendedInfo, $pExtendedInfo, $false)

    if (-not [Win32JobNative]::SetInformationJobObject($hJob, [Win32JobNative]::JobObjectExtendedLimitInformation, $pExtendedInfo, [uint32]$sizeExtended)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = "SetInformationJobObject failed with Win32 error $err"
        }
        exit 1
    }

    # Initialize Attribute List for STARTUPINFOEX
    $attrSize = [IntPtr]::Zero
    [Win32JobNative]::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$attrSize) | Out-Null
    $attributeList = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($attrSize)
    if (-not [Win32JobNative]::InitializeProcThreadAttributeList($attributeList, 1, 0, [ref]$attrSize)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = "InitializeProcThreadAttributeList failed with Win32 error $err"
        }
        exit 1
    }

    # Update Attribute List with PROC_THREAD_ATTRIBUTE_JOB_LIST
    $pJobHandle = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size)
    [System.Runtime.InteropServices.Marshal]::WriteIntPtr($pJobHandle, $hJob)

    if (-not [Win32JobNative]::UpdateProcThreadAttribute(
        $attributeList,
        0,
        [IntPtr][Win32JobNative]::PROC_THREAD_ATTRIBUTE_JOB_LIST,
        $pJobHandle,
        [IntPtr][IntPtr]::Size,
        [IntPtr]::Zero,
        [IntPtr]::Zero)) {

        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = "UpdateProcThreadAttribute (JOB_LIST) failed with Win32 error $err"
        }
        exit 1
    }

    # Prepare STARTUPINFOEX
    $siex = New-Object Win32JobNative+STARTUPINFOEX
    $siex.StartupInfo.cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32JobNative+STARTUPINFOEX])
    $siex.lpAttributeList = $attributeList

    # Launch root process suspended inside the Job Object
    $creationFlags = [Win32JobNative]::EXTENDED_STARTUPINFO_PRESENT -bor
                     [Win32JobNative]::CREATE_SUSPENDED -bor
                     [Win32JobNative]::CREATE_UNICODE_ENVIRONMENT

    $targetDir = if ([string]::IsNullOrEmpty($req.cwd)) { $null } else { $req.cwd }

    $created = [Win32JobNative]::CreateProcess(
        $null,
        $req.commandLine,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        $false, # Do NOT inherit handles
        $creationFlags,
        [IntPtr]::Zero,
        $targetDir,
        [ref]$siex,
        [ref]$pi
    )

    if (-not $created) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = "CreateProcessW failed with Win32 error $err"
        }
        exit 1
    }

    # Verify atomic job membership before resuming thread
    $inJob = $false
    if (-not [Win32JobNative]::IsProcessInJob($pi.hProcess, $hJob, [ref]$inJob) -or -not $inJob) {
        # Unwind suspended process: terminate immediately
        [Win32JobNative]::TerminateProcess($pi.hProcess, 1) | Out-Null
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = "Process was not successfully admitted into the Job Object."
        }
        exit 1
    }

    # Acknowledge admission success
    Send-ControlFrame $pipe @{
        schemaVersion = 1
        kind = 'ack'
        controllerId = 'liftoff-windows-job-controller-v1'
        workspaceId = $WorkspaceId
        invocationId = $InvocationId
        nonce = $ExpectedNonce
        sequence = 1
        admitted = $true
    }

    # Resume the root thread
    [Win32JobNative]::ResumeThread($pi.hThread) | Out-Null
    [Win32JobNative]::CloseHandle($pi.hThread) | Out-Null
    $pi.hThread = [IntPtr]::Zero

    # Monitor root process and Job accounting
    $timeoutMs = if ($req.timeoutMs -gt 0) { [int]$req.timeoutMs } else { 120000 }
    $startTime = [System.Diagnostics.Stopwatch]::StartNew()

    $sizeAccounting = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32JobNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION])
    $pAccounting = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($sizeAccounting)

    $rootExitCode = $null
    $terminated = $false

    while ($true) {
        if ($startTime.ElapsedMilliseconds -ge $timeoutMs) {
            # Timeout: terminate the entire Job Object
            [Win32JobNative]::TerminateJobObject($hJob, 1) | Out-Null
            $terminated = $true
            break
        }

        # Check if root process exited
        if ($null -eq $rootExitCode) {
            $wait = [Win32JobNative]::WaitForSingleObject($pi.hProcess, 50)
            if ($wait -eq [Win32JobNative]::WAIT_OBJECT_0) {
                $code = [uint32]0
                if ([Win32JobNative]::GetExitCodeProcess($pi.hProcess, [ref]$code)) {
                    $rootExitCode = [int]$code
                } else {
                    $rootExitCode = 1
                }
            }
        }

        # Check ActiveProcesses in Job
        $retLen = [uint32]0
        if ([Win32JobNative]::QueryInformationJobObject($hJob, [Win32JobNative]::JobObjectBasicAccountingInformation, $pAccounting, [uint32]$sizeAccounting, [ref]$retLen)) {
            $acct = [System.Runtime.InteropServices.Marshal]::PtrToStructure($pAccounting, [type][Win32JobNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION])
            if ($null -ne $rootExitCode -and $acct.ActiveProcesses -eq 0) {
                # Clean natural settlement
                break
            }
        }

        # Check if parent aborted or closed control pipe
        if (-not $pipe.IsConnected) {
            [Win32JobNative]::TerminateJobObject($hJob, 1) | Out-Null
            $terminated = $true
            break
        }
    }

    # If terminated, wait for ActiveProcesses to reach zero
    if ($terminated) {
        $termStart = [System.Diagnostics.Stopwatch]::StartNew()
        while ($termStart.ElapsedMilliseconds -lt 5000) {
            $retLen = [uint32]0
            if ([Win32JobNative]::QueryInformationJobObject($hJob, [Win32JobNative]::JobObjectBasicAccountingInformation, $pAccounting, [uint32]$sizeAccounting, [ref]$retLen)) {
                $acct = [System.Runtime.InteropServices.Marshal]::PtrToStructure($pAccounting, [type][Win32JobNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION])
                if ($acct.ActiveProcesses -eq 0) { break }
            }
            Start-Sleep -Milliseconds 25
        }
    }

    # Query final active processes
    $finalActive = 0
    $retLen = [uint32]0
    if ([Win32JobNative]::QueryInformationJobObject($hJob, [Win32JobNative]::JobObjectBasicAccountingInformation, $pAccounting, [uint32]$sizeAccounting, [ref]$retLen)) {
        $acct = [System.Runtime.InteropServices.Marshal]::PtrToStructure($pAccounting, [type][Win32JobNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION])
        $finalActive = [int]$acct.ActiveProcesses
    }

    # Send final response
    if ($terminated) {
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'response'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            phase = 'terminated'
            status = $null
            signal = 'SIGKILL'
            activeProcesses = $finalActive
            jobTerminated = $true
            settled = ($finalActive -eq 0)
        }
    } else {
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'response'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            phase = 'completed'
            status = $rootExitCode
            signal = $null
            activeProcesses = $finalActive
            jobTerminated = $false
            settled = ($finalActive -eq 0)
        }
    }
} catch {
    $errMsg = $_.ToString()
    try {
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'response'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            phase = 'failed'
            status = $null
            signal = $null
            activeProcesses = 0
            jobTerminated = $false
            settled = $false
            error = $errMsg
        }
    } catch { }
} finally {
    if ($pAccounting -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pAccounting) }
    if ($pExtendedInfo -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pExtendedInfo) }
    if ($pJobHandle -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pJobHandle) }
    if ($attributeList -ne [IntPtr]::Zero) {
        [Win32JobNative]::DeleteProcThreadAttributeList($attributeList) | Out-Null
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($attributeList)
    }
    if ($pi.hThread -ne [IntPtr]::Zero) { [Win32JobNative]::CloseHandle($pi.hThread) | Out-Null }
    if ($pi.hProcess -ne [IntPtr]::Zero) { [Win32JobNative]::CloseHandle($pi.hProcess) | Out-Null }
    if ($hJob -ne [IntPtr]::Zero) { [Win32JobNative]::CloseHandle($hJob) | Out-Null }
    if ($null -ne $pipe) { $pipe.Dispose() }
}
