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

# Resolve only the built-in cmdlets; unrelated installed-module discovery can exceed the startup deadline.
$PSModuleAutoLoadingPreference = 'None'
Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop

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
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
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

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CancelIoEx(IntPtr hFile, IntPtr lpOverlapped);

    public const uint STARTF_USESTDHANDLES = 0x00000100;
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint FILE_SHARE_DELETE = 0x00000004;
    public const uint CREATE_ALWAYS = 2;
    public const uint OPEN_EXISTING = 3;
    public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    public const uint HANDLE_FLAG_INHERIT = 0x00000001;

    public static STARTUPINFOEX CreateStartupInfoEx(IntPtr lpAttributeList, IntPtr hStdIn, IntPtr hStdOut, IntPtr hStdErr) {
        STARTUPINFOEX siex = new STARTUPINFOEX();
        siex.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
        siex.lpAttributeList = lpAttributeList;
        if (hStdOut != IntPtr.Zero && hStdErr != IntPtr.Zero && hStdOut.ToInt64() != -1 && hStdErr.ToInt64() != -1) {
            siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            siex.StartupInfo.hStdInput = hStdIn;
            siex.StartupInfo.hStdOutput = hStdOut;
            siex.StartupInfo.hStdError = hStdErr;
        }
        return siex;
    }

    public static JOBOBJECT_EXTENDED_LIMIT_INFORMATION CreateKillOnJobCloseExtendedInfo() {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        return info;
    }

    public static int LaunchInJobAndResume(
        string appPath,
        string commandLine,
        IntPtr pEnv,
        string targetDir,
        ref STARTUPINFOEX siex,
        bool hasStdHandles,
        IntPtr hJob,
        out IntPtr hProcess,
        out uint processId,
        out string errorMessage)
    {
        uint creationFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool created = CreateProcess(
            appPath,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            hasStdHandles,
            creationFlags,
            pEnv,
            targetDir,
            ref siex,
            out pi);

        if (!created) {
            int err = Marshal.GetLastWin32Error();
            hProcess = IntPtr.Zero;
            processId = 0;
            errorMessage = "CreateProcessW failed with Win32 error " + err;
            return 1;
        }

        bool inJob = false;
        if (!IsProcessInJob(pi.hProcess, hJob, out inJob) || !inJob) {
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            hProcess = IntPtr.Zero;
            processId = 0;
            errorMessage = "Process was not successfully admitted into the Job Object.";
            return 2;
        }

        uint resumeRes = ResumeThread(pi.hThread);
        if (resumeRes != 1) {
            int err = Marshal.GetLastWin32Error();
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            hProcess = IntPtr.Zero;
            processId = 0;
            errorMessage = resumeRes == unchecked((uint)-1)
                ? "ResumeThread failed with Win32 error " + err
                : "Unexpected initial thread suspend count " + resumeRes + "; expected 1.";
            return 3;
        }
        CloseHandle(pi.hThread);

        hProcess = pi.hProcess;
        processId = pi.dwProcessId;
        errorMessage = "";
        return 0;
    }
}
"@

try {
    Add-Type -TypeDefinition $win32TypeDef -ErrorAction Stop
} catch {
    Write-Error "Failed to load Win32 Job API definitions. Check LanguageMode and ExecutionPolicy: $_"
    exit 1
}

# Connect to the private control pipe
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $ControlPipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
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
    $len = ([int]$header[0] -shl 24) -bor ([int]$header[1] -shl 16) -bor ([int]$header[2] -shl 8) -bor [int]$header[3]
    if ($len -le 0 -or $len -gt 262144) {
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
$hProcess = [IntPtr]::Zero
$pi = New-Object Win32JobNative+PROCESS_INFORMATION
$attributeList = [IntPtr]::Zero
$pJobHandle = [IntPtr]::Zero
$pExtendedInfo = [IntPtr]::Zero
$pAccounting = [IntPtr]::Zero
$pEnv = [IntPtr]::Zero
$pHandleList = [IntPtr]::Zero
$hStdIn = [IntPtr]::Zero
$hStdOut = [IntPtr]::Zero
$hStdErr = [IntPtr]::Zero

try {
    # Send ready authentication frame to parent control pipe
    Send-ControlFrame $pipe @{
        schemaVersion = 1
        kind = 'ready'
        controllerId = 'liftoff-windows-job-controller-v1'
        workspaceId = $WorkspaceId
        invocationId = $InvocationId
        nonce = $ExpectedNonce
    }

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

    # Validate and allocate environment block if provided
    if (-not [string]::IsNullOrEmpty($req.envBlockBase64)) {
        $envBytes = [System.Convert]::FromBase64String($req.envBlockBase64)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $computedEnv = -join ($sha.ComputeHash($envBytes) | ForEach-Object { '{0:x2}' -f $_ })
        if ($computedEnv -ne $req.envDigest) {
            Send-ControlFrame $pipe @{
                schemaVersion = 1
                kind = 'ack'
                controllerId = 'liftoff-windows-job-controller-v1'
                workspaceId = $WorkspaceId
                invocationId = $InvocationId
                nonce = $ExpectedNonce
                sequence = 1
                admitted = $false
                error = "Target environment block digest mismatch."
            }
            exit 1
        }
        $pEnv = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($envBytes.Length)
        [System.Runtime.InteropServices.Marshal]::Copy($envBytes, 0, $pEnv, $envBytes.Length)
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
    $extendedInfo = [Win32JobNative]::CreateKillOnJobCloseExtendedInfo()
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

    # Prepare stdio file handles if specified
    $hasStdHandles = $false
    if (-not [string]::IsNullOrEmpty($req.stdoutFile) -and -not [string]::IsNullOrEmpty($req.stderrFile)) {
        $hStdIn = [Win32JobNative]::CreateFile(
            "NUL",
            [Win32JobNative]::GENERIC_READ,
            [Win32JobNative]::FILE_SHARE_READ -bor [Win32JobNative]::FILE_SHARE_WRITE,
            [IntPtr]::Zero,
            [Win32JobNative]::OPEN_EXISTING,
            [Win32JobNative]::FILE_ATTRIBUTE_NORMAL,
            [IntPtr]::Zero)
        $hStdOut = [Win32JobNative]::CreateFile(
            $req.stdoutFile,
            [Win32JobNative]::GENERIC_WRITE,
            [Win32JobNative]::FILE_SHARE_READ -bor [Win32JobNative]::FILE_SHARE_WRITE -bor [Win32JobNative]::FILE_SHARE_DELETE,
            [IntPtr]::Zero,
            [Win32JobNative]::CREATE_ALWAYS,
            [Win32JobNative]::FILE_ATTRIBUTE_NORMAL,
            [IntPtr]::Zero)
        $hStdErr = [Win32JobNative]::CreateFile(
            $req.stderrFile,
            [Win32JobNative]::GENERIC_WRITE,
            [Win32JobNative]::FILE_SHARE_READ -bor [Win32JobNative]::FILE_SHARE_WRITE -bor [Win32JobNative]::FILE_SHARE_DELETE,
            [IntPtr]::Zero,
            [Win32JobNative]::CREATE_ALWAYS,
            [Win32JobNative]::FILE_ATTRIBUTE_NORMAL,
            [IntPtr]::Zero)

        if ($hStdIn -eq [IntPtr]::Zero -or $hStdIn.ToInt64() -eq -1 -or
            $hStdOut -eq [IntPtr]::Zero -or $hStdOut.ToInt64() -eq -1 -or
            $hStdErr -eq [IntPtr]::Zero -or $hStdErr.ToInt64() -eq -1 -or
            -not [Win32JobNative]::SetHandleInformation($hStdIn, [Win32JobNative]::HANDLE_FLAG_INHERIT, [Win32JobNative]::HANDLE_FLAG_INHERIT) -or
            -not [Win32JobNative]::SetHandleInformation($hStdOut, [Win32JobNative]::HANDLE_FLAG_INHERIT, [Win32JobNative]::HANDLE_FLAG_INHERIT) -or
            -not [Win32JobNative]::SetHandleInformation($hStdErr, [Win32JobNative]::HANDLE_FLAG_INHERIT, [Win32JobNative]::HANDLE_FLAG_INHERIT)) {

            $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($hStdIn -ne [IntPtr]::Zero -and $hStdIn.ToInt64() -ne -1) { [Win32JobNative]::CloseHandle($hStdIn) | Out-Null; $hStdIn = [IntPtr]::Zero }
            if ($hStdOut -ne [IntPtr]::Zero -and $hStdOut.ToInt64() -ne -1) { [Win32JobNative]::CloseHandle($hStdOut) | Out-Null; $hStdOut = [IntPtr]::Zero }
            if ($hStdErr -ne [IntPtr]::Zero -and $hStdErr.ToInt64() -ne -1) { [Win32JobNative]::CloseHandle($hStdErr) | Out-Null; $hStdErr = [IntPtr]::Zero }

            Send-ControlFrame $pipe @{
                schemaVersion = 1
                kind = 'ack'
                controllerId = 'liftoff-windows-job-controller-v1'
                workspaceId = $WorkspaceId
                invocationId = $InvocationId
                nonce = $ExpectedNonce
                sequence = 1
                admitted = $false
                error = "Failed to create or configure inheritable stdio capture file handles (Win32 error $err)."
            }
            exit 1
        }
        $hasStdHandles = $true
    }

    # Initialize Attribute List for STARTUPINFOEX
    $attributeCount = if ($hasStdHandles) { 2 } else { 1 }
    $attrSize = [IntPtr]::Zero
    [Win32JobNative]::InitializeProcThreadAttributeList([IntPtr]::Zero, $attributeCount, 0, [ref]$attrSize) | Out-Null
    $attributeList = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($attrSize)
    if (-not [Win32JobNative]::InitializeProcThreadAttributeList($attributeList, $attributeCount, 0, [ref]$attrSize)) {
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

    # Update Attribute List with PROC_THREAD_ATTRIBUTE_HANDLE_LIST if stdio handles exist
    if ($hasStdHandles) {
        $pHandleList = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size * 3)
        [System.Runtime.InteropServices.Marshal]::WriteIntPtr($pHandleList, 0, $hStdIn)
        [System.Runtime.InteropServices.Marshal]::WriteIntPtr($pHandleList, [IntPtr]::Size, $hStdOut)
        [System.Runtime.InteropServices.Marshal]::WriteIntPtr($pHandleList, [IntPtr]::Size * 2, $hStdErr)

        if (-not [Win32JobNative]::UpdateProcThreadAttribute(
            $attributeList,
            0,
            [IntPtr][Win32JobNative]::PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            $pHandleList,
            [IntPtr]([IntPtr]::Size * 3),
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
                error = "UpdateProcThreadAttribute (HANDLE_LIST) failed with Win32 error $err"
            }
            exit 1
        }
    }

    # Prepare STARTUPINFOEX via C# helper to guarantee native struct field initialization
    $siex = [Win32JobNative]::CreateStartupInfoEx($attributeList, $hStdIn, $hStdOut, $hStdErr)

    # Launch root process suspended inside the Job Object
    $creationFlags = [Win32JobNative]::EXTENDED_STARTUPINFO_PRESENT -bor
                     [Win32JobNative]::CREATE_SUSPENDED -bor
                     [Win32JobNative]::CREATE_UNICODE_ENVIRONMENT

    $targetDir = if ([string]::IsNullOrEmpty($req.cwd)) { $null } else { $req.cwd }
    if ([string]::IsNullOrEmpty($req.executable) -or -not [System.IO.Path]::IsPathRooted($req.executable) -or -not [System.IO.File]::Exists($req.executable)) {
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = "Admitted executable must be an existing rooted file path: $($req.executable)"
        }
        exit 1
    }
    $appPath = $req.executable

    $hProcess = [IntPtr]::Zero
    $processId = [uint32]0
    $launchError = ""
    $launchRes = [Win32JobNative]::LaunchInJobAndResume(
        $appPath,
        $req.commandLine,
        $pEnv,
        $targetDir,
        [ref]$siex,
        $hasStdHandles,
        $hJob,
        [ref]$hProcess,
        [ref]$processId,
        [ref]$launchError
    )

    if ($launchRes -ne 0) {
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'ack'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            admitted = $false
            error = $launchError
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

    # Begin asynchronous read on control pipe to detect parent disconnect or abort
    $pipeBuffer = New-Object byte[] 1
    $pipeAsync = $pipe.BeginRead($pipeBuffer, 0, 1, $null, $null)

    # Monitor root process and Job accounting
    $timeoutMs = if ($req.timeoutMs -gt 0) { [int]$req.timeoutMs } else { 120000 }
    $maxBytes = if ($req.maxOutputBytes -gt 0) { [int]$req.maxOutputBytes } else { 65536 }
    $startTime = [System.Diagnostics.Stopwatch]::StartNew()

    $sizeAccounting = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32JobNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION])
    $pAccounting = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($sizeAccounting)

    $rootExitCode = $null
    $terminated = $false
    $outputLimitExceeded = $false

    while ($true) {
        if ($startTime.ElapsedMilliseconds -ge $timeoutMs) {
            # Timeout: terminate the entire Job Object
            [Win32JobNative]::TerminateJobObject($hJob, 1) | Out-Null
            $terminated = $true
            break
        }

        # Check output limits if files are present
        if ($hasStdHandles) {
            $currentBytes = 0
            if ([System.IO.File]::Exists($req.stdoutFile)) { $currentBytes += (New-Object System.IO.FileInfo($req.stdoutFile)).Length }
            if ([System.IO.File]::Exists($req.stderrFile)) { $currentBytes += (New-Object System.IO.FileInfo($req.stderrFile)).Length }
            if ($currentBytes -gt $maxBytes) {
                $outputLimitExceeded = $true
                [Win32JobNative]::TerminateJobObject($hJob, 1) | Out-Null
                $terminated = $true
                break
            }
        }

        # Check if root process exited
        if ($null -eq $rootExitCode) {
            $wait = [Win32JobNative]::WaitForSingleObject($hProcess, 50)
            if ($wait -eq [Win32JobNative]::WAIT_OBJECT_0) {
                $code = [uint32]0
                if ([Win32JobNative]::GetExitCodeProcess($hProcess, [ref]$code)) {
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
                # Recheck output limit before declaring clean natural settlement
                if ($hasStdHandles) {
                    $finalBytes = 0
                    if ([System.IO.File]::Exists($req.stdoutFile)) { $finalBytes += (New-Object System.IO.FileInfo($req.stdoutFile)).Length }
                    if ([System.IO.File]::Exists($req.stderrFile)) { $finalBytes += (New-Object System.IO.FileInfo($req.stderrFile)).Length }
                    if ($finalBytes -gt $maxBytes) {
                        $outputLimitExceeded = $true
                        $terminated = $true
                    }
                }
                break
            }
        }

        # Check if parent aborted or closed control pipe via completed asynchronous read or connection state
        if ($pipeAsync.IsCompleted -or -not $pipe.IsConnected) {
            try { [void]$pipe.EndRead($pipeAsync) } catch {}
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
    $finalActive = -1
    $accountingOk = $false
    $retLen = [uint32]0
    if ([Win32JobNative]::QueryInformationJobObject($hJob, [Win32JobNative]::JobObjectBasicAccountingInformation, $pAccounting, [uint32]$sizeAccounting, [ref]$retLen)) {
        $acct = [System.Runtime.InteropServices.Marshal]::PtrToStructure($pAccounting, [type][Win32JobNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION])
        $finalActive = [int]$acct.ActiveProcesses
        $accountingOk = $true
    }

    if ($null -ne $pipeAsync -and -not $pipeAsync.IsCompleted) {
        [Win32JobNative]::CancelIoEx($pipe.SafePipeHandle.DangerousGetHandle(), [IntPtr]::Zero) | Out-Null
        try { [void]$pipe.EndRead($pipeAsync) } catch {}
    }

    if ($hStdIn -ne [IntPtr]::Zero -and $hStdIn.ToInt64() -ne -1) {
        [Win32JobNative]::CloseHandle($hStdIn) | Out-Null
        $hStdIn = [IntPtr]::Zero
    }
    if ($hStdOut -ne [IntPtr]::Zero -and $hStdOut.ToInt64() -ne -1) {
        [Win32JobNative]::CloseHandle($hStdOut) | Out-Null
        $hStdOut = [IntPtr]::Zero
    }
    if ($hStdErr -ne [IntPtr]::Zero -and $hStdErr.ToInt64() -ne -1) {
        [Win32JobNative]::CloseHandle($hStdErr) | Out-Null
        $hStdErr = [IntPtr]::Zero
    }

    if (-not $accountingOk -or $finalActive -lt 0) {
        Send-ControlFrame $pipe @{
            schemaVersion = 1
            kind = 'response'
            controllerId = 'liftoff-windows-job-controller-v1'
            workspaceId = $WorkspaceId
            invocationId = $InvocationId
            nonce = $ExpectedNonce
            sequence = 1
            phase = 'failed'
            status = $rootExitCode
            signal = $null
            activeProcesses = -1
            jobTerminated = $terminated
            settled = $false
            error = "QueryInformationJobObject failed to retrieve kernel basic accounting information; settlement cannot be proven."
        }
        exit 1
    }

    $isSettled = ($finalActive -eq 0)
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
            settled = $isSettled
            outputLimitExceeded = $outputLimitExceeded
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
            settled = $isSettled
            outputLimitExceeded = $outputLimitExceeded
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
    if ($pEnv -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pEnv) }
    if ($pHandleList -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pHandleList) }
    if ($hStdIn -ne [IntPtr]::Zero -and $hStdIn.ToInt64() -ne -1) { [Win32JobNative]::CloseHandle($hStdIn) | Out-Null }
    if ($hStdOut -ne [IntPtr]::Zero -and $hStdOut.ToInt64() -ne -1) { [Win32JobNative]::CloseHandle($hStdOut) | Out-Null }
    if ($hStdErr -ne [IntPtr]::Zero -and $hStdErr.ToInt64() -ne -1) { [Win32JobNative]::CloseHandle($hStdErr) | Out-Null }
    if ($pAccounting -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pAccounting) }
    if ($pExtendedInfo -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pExtendedInfo) }
    if ($pJobHandle -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pJobHandle) }
    if ($attributeList -ne [IntPtr]::Zero) {
        [Win32JobNative]::DeleteProcThreadAttributeList($attributeList) | Out-Null
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($attributeList)
    }
    if ($pi.hThread -ne [IntPtr]::Zero) { [Win32JobNative]::CloseHandle($pi.hThread) | Out-Null }
    if ($pi.hProcess -ne [IntPtr]::Zero) { [Win32JobNative]::CloseHandle($pi.hProcess) | Out-Null }
    if ($hProcess -ne [IntPtr]::Zero) { [Win32JobNative]::CloseHandle($hProcess) | Out-Null }
    if ($hJob -ne [IntPtr]::Zero) { [Win32JobNative]::CloseHandle($hJob) | Out-Null }
    if ($null -ne $pipe) { $pipe.Dispose() }
}
