<#
Private binary process transport. This helper does not admit storage or key custody.
No private payload is encoded as PowerShell text, command-line arguments or files.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][uint32]$ParentProcessId)

$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
try {
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage' -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
        [Environment]::OSVersion.Version.Build -lt 17763) {
        throw 'Unsupported private process host.'
    }
    Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
    Add-Type -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public sealed class LiftoffPrivateProcess {
    const uint Suspended = 4, Extended = 0x80000, UnicodeEnvironment = 0x400;
    const uint Inherit = 1, StillActive = 259, WaitTimeout = 258;
    const int CleanupMs = 2000;
    [StructLayout(LayoutKind.Sequential)] struct Security {
        public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public uint cb; public IntPtr reserved, desktop, title;
        public uint x, y, xsize, ysize, xchars, ychars, fill, flags;
        public ushort show, reservedSize; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorking, maxWorking; public uint activeLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit basic; public IoCounters io; public UIntPtr a, b, c, d;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long a, b, c, d; public uint faults, total, active, terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessEntry {
        public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent;
        public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string image;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security attrs, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint rights, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint rights, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CancelSynchronousIo(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr handle, byte[] bytes, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr handle, IntPtr bytes, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr prior, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);

    readonly Stream input = Console.OpenStandardInput();
    readonly Stream output = Console.OpenStandardOutput();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 8 };
    readonly object outputLock = new object();
    readonly List<IntPtr> handles = new List<IntPtr>();
    readonly List<Worker> workers = new List<Worker>();
    Worker inputWriter;
    IntPtr parent, job, mainThread;
    long parentCreated, controllerCreated, stoppedAt;
    string nonce;
    int reason, completed, outputBytes, maximumBytes;
    volatile bool targetStarted;
    Stopwatch clock = Stopwatch.StartNew();
    int deadlineMs = 15000;
    ProcessInfo target;
    byte[] privateInput;
    GCHandle privateInputPin;

    sealed class Worker {
        public Thread thread; public IntPtr handle; public bool supervisor;
        public readonly ManualResetEvent ready = new ManualResetEvent(false);
    }
    static void Need(bool condition) { if (!condition) throw new InvalidOperationException("Private process admission failed."); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero; }
    IntPtr Own(IntPtr handle) { Need(handle != IntPtr.Zero && handle != new IntPtr(-1)); handles.Add(handle); return handle; }
    static long Created(IntPtr process) {
        long created, exited, kernel, user;
        Need(GetProcessTimes(process, out created, out exited, out kernel, out user) && created > 0);
        return created;
    }
    static string TimeText(long value) { return value.ToString(CultureInfo.InvariantCulture); }
    static void SafePath(string value, bool directory) {
        Need(Path.IsPathRooted(value) && value.Length > 3 && value.IndexOf('\0') < 0 &&
            !value.StartsWith(@"\\") && String.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase));
        string item = value;
        while (!String.IsNullOrEmpty(item)) {
            FileAttributes attrs = File.GetAttributes(item);
            Need((attrs & FileAttributes.ReparsePoint) == 0);
            if (item == value) Need(((attrs & FileAttributes.Directory) != 0) == directory);
            item = Path.GetDirectoryName(item);
        }
    }
    static string Quote(string argument) {
        Need(argument != null && argument.IndexOf('\0') < 0);
        StringBuilder value = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in argument) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') value.Append('\\', slashes * 2 + 1);
            else value.Append('\\', slashes);
            slashes = 0; value.Append(c);
        }
        value.Append('\\', slashes * 2); return value.Append('"').ToString();
    }
    byte[] ReadExact(int count, bool privateBytes = false) {
        byte[] bytes = new byte[count];
        if (privateBytes) privateInputPin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            for (int offset = 0; offset < count;) {
                int read = input.Read(bytes, offset, count - offset);
                Need(read > 0); offset += read;
            }
            return bytes;
        } catch {
            Array.Clear(bytes, 0, bytes.Length);
            if (privateBytes && privateInputPin.IsAllocated) privateInputPin.Free();
            throw;
        }
    }
    byte[] ReadFrame(byte type, int maximum) {
        byte[] header = ReadExact(5);
        uint length = ((uint)header[1] << 24) | ((uint)header[2] << 16) | ((uint)header[3] << 8) | header[4];
        Need(header[0] == type && length <= maximum);
        return ReadExact((int)length, type == 3);
    }
    Dictionary<string, object> ReadMessage(byte type) {
        byte[] bytes = ReadFrame(type, 131072);
        try { return json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes)); }
        finally { Array.Clear(bytes, 0, bytes.Length); }
    }
    void Send(byte type, byte[] bytes, int count) {
        byte[] header = { type, (byte)(count >> 24), (byte)(count >> 16), (byte)(count >> 8), (byte)count };
        lock (outputLock) { output.Write(header, 0, header.Length); output.Write(bytes, 0, count); output.Flush(); }
    }
    void Message(byte type, object value) {
        byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(value));
        try { Send(type, bytes, bytes.Length); } finally { Array.Clear(bytes, 0, bytes.Length); }
    }
    void Authenticate(Dictionary<string, object> value) {
        Need(value.ContainsKey("nonce") && (string)value["nonce"] == nonce);
    }
    void Stop(int code) {
        Interlocked.CompareExchange(ref reason, code, 0);
        Interlocked.CompareExchange(ref stoppedAt, Stopwatch.GetTimestamp(), 0);
        if (job != IntPtr.Zero) TerminateJobObject(job, 1);
    }
    int RemainingCleanup() {
        Interlocked.CompareExchange(ref stoppedAt, Stopwatch.GetTimestamp(), 0);
        long elapsed = (Stopwatch.GetTimestamp() - Interlocked.Read(ref stoppedAt)) * 1000 / Stopwatch.Frequency;
        return (int)Math.Max(0, CleanupMs - elapsed);
    }
    bool JoinWorkers() {
        Volatile.Write(ref completed, 1);
        foreach (Worker worker in workers) if (!worker.supervisor && worker.handle != IntPtr.Zero) CancelSynchronousIo(worker.handle);
        bool joined = true;
        foreach (Worker worker in workers) if (!worker.supervisor) joined &= worker.thread.Join(RemainingCleanup());
        return joined;
    }
    uint Active() {
        if (job == IntPtr.Zero) return 0;
        Accounting accounting; uint returned;
        Need(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), out returned));
        Need(returned == Marshal.SizeOf(typeof(Accounting)));
        return accounting.active;
    }
    Worker Start(Action action, bool writesInput = false, bool supervisor = false) {
        Worker worker = new Worker { supervisor = supervisor };
        if (writesInput) inputWriter = worker;
        worker.thread = new Thread(delegate() {
            worker.handle = OpenThread(0x0001, false, GetCurrentThreadId());
            worker.ready.Set();
            try { Need(worker.handle != IntPtr.Zero); action(); }
            catch { if (Volatile.Read(ref completed) == 0) Stop(5); }
        });
        worker.thread.IsBackground = true;
        workers.Add(worker); worker.thread.Start();
        Need(worker.ready.WaitOne(CleanupMs) && worker.handle != IntPtr.Zero);
        return worker;
    }
    void ReadOutput(IntPtr pipe, byte type) {
        byte[] bytes = new byte[16384];
        GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            while (Volatile.Read(ref reason) == 0) {
                uint read;
                if (!ReadFile(pipe, bytes, (uint)bytes.Length, out read, IntPtr.Zero)) {
                    Need(Marshal.GetLastWin32Error() == 109); break;
                }
                if (read == 0) break;
                if (Interlocked.Add(ref outputBytes, (int)read) > maximumBytes) { Stop(4); break; }
                Send(type, bytes, (int)read);
                Array.Clear(bytes, 0, bytes.Length);
            }
        } finally { Array.Clear(bytes, 0, bytes.Length); pinned.Free(); }
    }
    void WriteInput(IntPtr pipe) {
        try {
            int offset = 0;
            while (offset < privateInput.Length && Volatile.Read(ref reason) == 0) {
                uint written;
                Need(WriteFile(pipe, IntPtr.Add(privateInputPin.AddrOfPinnedObject(), offset),
                    (uint)(privateInput.Length - offset), out written, IntPtr.Zero) && written > 0);
                offset += (int)written;
            }
            Need(offset == privateInput.Length || Volatile.Read(ref reason) != 0);
        } finally {
            Array.Clear(privateInput, 0, privateInput.Length);
            CloseHandle(pipe);
        }
    }
    void AdmitParent(uint expected) {
        uint self = GetCurrentProcessId();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        Need(snapshot != new IntPtr(-1));
        try {
            ProcessEntry entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            bool found = false;
            for (bool next = Process32First(snapshot, ref entry); next; next = Process32Next(snapshot, ref entry)) {
                if (entry.pid == self) { Need(entry.parent == expected); found = true; break; }
            }
            Need(found);
        } finally { CloseHandle(snapshot); }
        parent = Own(OpenProcess(0x00100000 | 0x1000, false, expected));
        parentCreated = Created(parent); controllerCreated = Created(GetCurrentProcess());
        Need(parentCreated <= controllerCreated && WaitForSingleObject(parent, 0) == WaitTimeout);
    }
    void Execute(uint parentId) {
        AdmitParent(parentId);
        Need(GetFileType(GetStdHandle(-10)) == 3 && GetFileType(GetStdHandle(-11)) == 3);
        mainThread = Own(OpenThread(0x0001, false, GetCurrentThreadId()));
        Worker watch = Start(delegate() {
            while (Volatile.Read(ref completed) != 2) {
                if (WaitForSingleObject(parent, 0) != WaitTimeout) { Stop(3); CancelSynchronousIo(mainThread); }
                if (Volatile.Read(ref completed) == 0 && clock.ElapsedMilliseconds > Volatile.Read(ref deadlineMs)) {
                    Stop(1); CancelSynchronousIo(mainThread);
                }
                if (Interlocked.Read(ref stoppedAt) != 0 && RemainingCleanup() == 0) {
                    Stop(7);
                    TerminateProcess(GetCurrentProcess(), 1);
                    return;
                }
                Thread.Sleep(10);
            }
        }, false, true);
        Dictionary<string, object> hello = ReadMessage(1);
        Need(hello.Count == 2 && Convert.ToInt32(hello["schemaVersion"]) == 1);
        nonce = (string)hello["nonce"];
        Need(nonce.Length == 64 && System.Text.RegularExpressions.Regex.IsMatch(nonce, "^[a-f0-9]{64}$"));
        Message(11, new { schemaVersion = 1, nonce, controllerPid = GetCurrentProcessId(),
            controllerCreated = TimeText(controllerCreated), parentPid = parentId, parentCreated = TimeText(parentCreated) });
        Dictionary<string, object> request = ReadMessage(2);
        Authenticate(request);
        Need(request.Count == 9);
        string executable = (string)request["executable"], cwd = (string)request["cwd"], expectedDigest = (string)request["executableSha256"];
        int timeout = Convert.ToInt32(request["timeoutMs"]);
        maximumBytes = Convert.ToInt32(request["maximumBytes"]);
        Need(timeout > 0 && timeout <= 300000 && maximumBytes > 0 && maximumBytes <= 2097152);
        Need(cwd.Length + (cwd.EndsWith("\\") || cwd.EndsWith("/") ? 0 : 1) + 1 <= 260);
        SafePath(executable, false); SafePath(cwd, true);
        Need(executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase));
        Need((string)request["controllerCreated"] == TimeText(controllerCreated) &&
            (string)request["parentCreated"] == TimeText(parentCreated));
        System.Collections.ICollection arguments = request["args"] as System.Collections.ICollection;
        Need(arguments != null && arguments.Count <= 256);
        StringBuilder command = new StringBuilder(Quote(executable));
        foreach (object argument in arguments) command.Append(" ").Append(Quote((string)argument));
        Need(command.Length < 32767);
        privateInput = ReadFrame(3, 1048576);
        job = Own(CreateJobObject(IntPtr.Zero, null));
        ExtendedLimit limits = new ExtendedLimit(); limits.basic.flags = 0x2000;
        Need(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
        IntPtr descriptor;
        uint descriptorSize;
        string sid = WindowsIdentity.GetCurrent().User.Value;
        Need(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out descriptor, out descriptorSize));
        IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
        try {
            Security security = new Security { length = Marshal.SizeOf(typeof(Security)), descriptor = descriptor, inherit = true };
            Need(CreatePipe(out inputRead, out inputWrite, ref security, 4096));
            Own(inputRead); Own(inputWrite);
            Need(CreatePipe(out outputRead, out outputWrite, ref security, 4096)); Own(outputRead); Own(outputWrite);
            Need(CreatePipe(out errorRead, out errorWrite, ref security, 4096)); Own(errorRead); Own(errorWrite);
            Need(SetHandleInformation(inputWrite, Inherit, 0) && SetHandleInformation(outputRead, Inherit, 0) && SetHandleInformation(errorRead, Inherit, 0));
        } finally { LocalFree(descriptor); }
        IntPtr attributesSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributesSize);
        Need(attributesSize != IntPtr.Zero);
        IntPtr attributes = Marshal.AllocHGlobal(attributesSize), jobList = Marshal.AllocHGlobal(IntPtr.Size), handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
        IntPtr environment = IntPtr.Zero;
        bool initialized = false;
        try {
            Need(InitializeProcThreadAttributeList(attributes, 2, 0, ref attributesSize)); initialized = true;
            Marshal.WriteIntPtr(jobList, job);
            Marshal.WriteIntPtr(handleList, 0, inputRead); Marshal.WriteIntPtr(handleList, IntPtr.Size, outputWrite); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errorWrite);
            Need(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            Need(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            string system = Environment.GetFolderPath(Environment.SpecialFolder.System);
            string windows = Directory.GetParent(system).FullName;
            string env = "PATH=" + Path.GetDirectoryName(executable) + ";" + system + "\0SystemRoot=" + windows + "\0TEMP=" + cwd + "\0TMP=" + cwd + "\0WINDIR=" + windows + "\0\0";
            environment = Marshal.StringToHGlobalUni(env);
            StartupEx startup = new StartupEx();
            startup.startup.cb = (uint)Marshal.SizeOf(typeof(StartupEx));
            startup.startup.flags = 0x100;
            startup.startup.input = inputRead; startup.startup.output = outputWrite; startup.startup.error = errorWrite;
            startup.attributes = attributes;
            using (FileStream image = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                Need(image.Length > 0 && image.Length <= 268435456);
                using (SHA256 hash = SHA256.Create()) Need(BitConverter.ToString(hash.ComputeHash(image)).Replace("-", "").ToLowerInvariant() == expectedDigest);
                Need(Volatile.Read(ref reason) == 0 && WaitForSingleObject(parent, 0) == WaitTimeout);
                Need(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                    Suspended | Extended | UnicodeEnvironment, environment, cwd, ref startup, out target));
                targetStarted = true; Own(target.process); Own(target.thread);
                bool member;
                Need(IsProcessInJob(target.process, job, out member) && member && Active() == 1);
                long created = Created(target.process);
                Message(12, new { nonce, pid = target.pid, created = TimeText(created), assignedBeforeExecution = true });
                Dictionary<string, object> resume = ReadMessage(5);
                Authenticate(resume);
                Need(resume.Count == 3 && Convert.ToUInt32(resume["pid"]) == target.pid && (string)resume["created"] == TimeText(created));
                Need(Volatile.Read(ref reason) == 0 && WaitForSingleObject(parent, 0) == WaitTimeout);
                clock.Restart(); Volatile.Write(ref deadlineMs, timeout);
                Need(ResumeThread(target.thread) == 1);
            }
        } finally {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(jobList); Marshal.FreeHGlobal(handleList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
        handles.Remove(inputRead); Close(ref inputRead);
        handles.Remove(outputWrite); Close(ref outputWrite);
        handles.Remove(errorWrite); Close(ref errorWrite);
        IntPtr writer = inputWrite; handles.Remove(writer);
        Worker inputWorker = Start(delegate() { WriteInput(writer); }, true);
        Worker stdoutWorker = Start(delegate() { ReadOutput(outputRead, 13); });
        Worker stderrWorker = Start(delegate() { ReadOutput(errorRead, 14); });
        Worker controlWorker = Start(delegate() {
            Dictionary<string, object> cancel = ReadMessage(4); Authenticate(cancel);
            Need(cancel.Count == 1); Stop(2);
        });
        uint active = 1;
        while (true) {
            active = Active();
            if (Volatile.Read(ref reason) == 0 && WaitForSingleObject(target.process, 0) == 0 && active != 0) Stop(6);
            if (active == 0 && !inputWorker.thread.IsAlive && !stdoutWorker.thread.IsAlive && !stderrWorker.thread.IsAlive) break;
            if (Volatile.Read(ref reason) != 0) {
                TerminateJobObject(job, 1);
                foreach (Worker worker in workers) if (worker != watch && worker != controlWorker) CancelSynchronousIo(worker.handle);
                if (RemainingCleanup() == 0) break;
            }
            Thread.Sleep(10);
        }
        bool joined = JoinWorkers();
        uint exit = 1;
        bool settled = joined && Active() == 0 && WaitForSingleObject(target.process, 0) == 0 && GetExitCodeProcess(target.process, out exit);
        if (!settled) exit = 1;
        Message(15, new { nonce, settled, activeProcesses = Active(), rootExited = WaitForSingleObject(target.process, 0) == 0,
            processSpawned = true, exitCode = exit, reason = Volatile.Read(ref reason), inputDisposed = inputWorker.thread.IsAlive == false });
    }
    public static int Run(uint parentId) {
        LiftoffPrivateProcess controller = new LiftoffPrivateProcess();
        try { controller.Execute(parentId); return 0; }
        catch {
            controller.Stop(7);
            try {
                bool settled = !controller.targetStarted;
                if (controller.targetStarted) {
                    while (controller.Active() != 0 && controller.RemainingCleanup() > 0) Thread.Sleep(10);
                    settled = controller.Active() == 0 && WaitForSingleObject(controller.target.process, 0) == 0;
                }
                bool joined = controller.JoinWorkers();
                settled &= joined;
                if (controller.privateInput != null && joined) Array.Clear(controller.privateInput, 0, controller.privateInput.Length);
                controller.Message(15, new { nonce = controller.nonce, settled, activeProcesses = controller.Active(),
                    rootExited = !controller.targetStarted || WaitForSingleObject(controller.target.process, 0) == 0,
                    processSpawned = controller.targetStarted, exitCode = 1, reason = Volatile.Read(ref controller.reason), inputDisposed = joined });
            } catch { }
            return 1;
        } finally {
            Volatile.Write(ref controller.completed, 2);
            foreach (Worker worker in controller.workers) CancelSynchronousIo(worker.handle);
            foreach (Worker worker in controller.workers) {
                if (worker.thread.Join(controller.RemainingCleanup())) { Close(ref worker.handle); worker.ready.Dispose(); }
            }
            if (controller.privateInput != null && (controller.inputWriter == null || !controller.inputWriter.thread.IsAlive)) {
                Array.Clear(controller.privateInput, 0, controller.privateInput.Length);
                if (controller.privateInputPin.IsAllocated) controller.privateInputPin.Free();
            }
            for (int index = controller.handles.Count - 1; index >= 0; index--) CloseHandle(controller.handles[index]);
        }
    }
}
'@
    exit ([LiftoffPrivateProcess]::Run($ParentProcessId))
} catch {
    [Console]::Error.WriteLine('WINDOWS_PRIVATE_HELPER_UNAVAILABLE')
    exit 1
}
