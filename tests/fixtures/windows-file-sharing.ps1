$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'SOURCE_POWERSHELL_HOST' }
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'SOURCE_LANGUAGE_MODE' }
Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Add-Type -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class SourceFileSharingProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint Attributes;
    public FileTime Creation;
    public FileTime Access;
    public FileTime Write;
    public uint Volume;
    public uint SizeHigh;
    public uint SizeLow;
    public uint Links;
    public uint IndexHigh;
    public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint length, uint flags);

  private static FileInformation Information(SafeFileHandle handle) {
    FileInformation information;
    if (handle.IsClosed || handle.IsInvalid || !GetFileInformationByHandle(handle, out information))
      throw new InvalidOperationException("SOURCE_HANDLE_INFORMATION");
    return information;
  }
  private static string Index(FileInformation information) {
    return (((ulong)information.IndexHigh << 32) | information.IndexLow).ToString(CultureInfo.InvariantCulture);
  }
  private static Dictionary<string, object> Observe(SafeFileHandle handle, string file, string mode) {
    FileInformation information = Information(handle);
    StringBuilder finalName = new StringBuilder(2048);
    uint length = GetFinalPathNameByHandleW(handle, finalName, (uint)finalName.Capacity, 0);
    if (length == 0 || length >= finalName.Capacity) throw new InvalidOperationException("SOURCE_FINAL_NAME");
    string actual = finalName.ToString();
    if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual.Substring(4);
    int secondError;
    object sameFile = null;
    using (SafeFileHandle second = CreateFileW(file, 0x120089, 7, IntPtr.Zero, 3, 0x02000080, IntPtr.Zero)) {
      secondError = second.IsInvalid ? Marshal.GetLastWin32Error() : 0;
      if (!second.IsInvalid) {
        FileInformation secondInformation = Information(second);
        sameFile = secondInformation.Volume == information.Volume && Index(secondInformation) == Index(information);
      }
    }
    return new Dictionary<string, object> {
      { "mode", mode }, { "processId", Process.GetCurrentProcess().Id }, { "handleValid", true },
      { "volumeSerial", information.Volume }, { "fileIndex", Index(information) },
      { "links", information.Links }, { "size", ((ulong)information.SizeHigh << 32) | information.SizeLow },
      { "finalNameMatchesRequested", String.Equals(actual, Path.GetFullPath(file), StringComparison.OrdinalIgnoreCase) },
      { "requestedAccess", 2147483648L }, { "requestedShare", 0 },
      { "secondRequestedAccess", 0x120089 }, { "secondRequestedShare", 7 }, { "secondFlags", 0x02000080 },
      { "secondOpenError", secondError }, { "secondOpenSameFile", sameFile }
    };
  }
  private static void Save(string marker, object value) {
    string temporary = marker + ".tmp";
    using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
      byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value));
      output.Write(bytes, 0, bytes.Length);
      output.Flush(true);
      Array.Clear(bytes, 0, bytes.Length);
    }
    File.Move(temporary, marker);
  }
  public static void Run(string file, string mode, string ready, string release, string done) {
    FileStream stream = null;
    SafeFileHandle native = null;
    Dictionary<string, object> final = null;
    try {
      SafeFileHandle handle;
      if (mode == "managed") {
        stream = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None);
        handle = stream.SafeFileHandle;
      } else if (mode == "kernel") {
        native = CreateFileW(file, 0x80000000, 0, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
        handle = native;
      } else { throw new InvalidOperationException("SOURCE_MODE"); }
      Save(ready, Observe(handle, file, mode));
      Stopwatch elapsed = Stopwatch.StartNew();
      while (!File.Exists(release)) {
        if (elapsed.ElapsedMilliseconds >= 10000) throw new TimeoutException("SOURCE_RELEASE_DEADLINE");
        Thread.Sleep(20);
      }
      final = Observe(handle, file, mode);
      GC.KeepAlive(stream);
    } finally {
      if (stream != null) stream.Dispose();
      if (native != null) native.Dispose();
    }
    Save(done, final);
  }
}
'@
[SourceFileSharingProbe]::Run(
  $env:LIFTOFF_SOURCE_FILE, $env:LIFTOFF_SOURCE_MODE,
  $env:LIFTOFF_SOURCE_READY, $env:LIFTOFF_SOURCE_RELEASE, $env:LIFTOFF_SOURCE_DONE)
exit 0
