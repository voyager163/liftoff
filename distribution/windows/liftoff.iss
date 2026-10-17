#ifndef BundleDir
  #error An exact verified runtime-inclusive BundleDir is required.
#endif
#ifndef PackageVersion
  #error The qualified package version is required.
#endif
#ifndef ApprovedAppId
  #error A verified operator-approved installer AppId is required.
#endif
#ifndef ApprovedPublisher
  #error A verified operator-approved publisher is required.
#endif
#ifndef ApprovedPublisherPascal
  #error The generated Pascal-safe publisher is required.
#endif
#ifndef VersionName
  #error Exact generated Windows installer inputs are required.
#endif
#ifndef ReceiptFile
  #error An exact generated installation receipt is required.
#endif
#ifndef CurrentFile
  #error An exact immutable version pointer is required.
#endif
#ifndef ReceiptSha256
  #error The exact receipt SHA-256 is required.
#endif
#ifndef CurrentSha256
  #error The exact pointer SHA-256 is required.
#endif
#ifndef StableLauncherSha256
  #error The exact stable launcher SHA-256 is required.
#endif
#ifndef ApprovedUninstallKey
  #error The approved AppId uninstall key is required.
#endif
#ifndef ApprovedCertificateSha256
  #error The approved Authenticode certificate SHA-256 is required.
#endif
#ifndef InstallerOutput
  #error A new private installer output directory is required.
#endif
#ifndef BundleFilesFile
  #error The exact generated inventory file list is required.
#endif
#ifndef BundleHashesFile
  #error The compile-time inventoried-file hash checks are required.
#endif
#include BundleHashesFile

[Setup]
AppId={#ApprovedAppId}
AppName=Liftoff
AppVersion={#PackageVersion}
AppPublisher={#ApprovedPublisher}
DefaultDirName={localappdata}\Programs\Liftoff
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.14393
DisableProgramGroupPage=yes
CloseApplications=no
RestartApplications=no
SignedUninstaller=yes
SignTool=liftoff
ChangesEnvironment=yes
OutputDir={#InstallerOutput}
OutputBaseFilename=liftoff-{#PackageVersion}-win32-x64-setup
Compression=lzma2
SolidCompression=yes

#include BundleFilesFile
Source: "{#BundleDir}\bin\liftoff.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "{#ReceiptFile}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#CurrentFile}"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{code:ReviewedUserPath}"; Flags: preservestringtype; Check: AppendUserPath
Root: HKCU; Subkey: "{#ApprovedUninstallKey}"; ValueType: string; ValueName: "LiftoffReceiptSha256"; ValueData: "{#ReceiptSha256}"
Root: HKCU; Subkey: "{#ApprovedUninstallKey}"; ValueType: string; ValueName: "LiftoffCurrentSha256"; ValueData: "{#CurrentSha256}"
Root: HKCU; Subkey: "{#ApprovedUninstallKey}"; ValueType: string; ValueName: "LiftoffLauncherSha256"; ValueData: "{#StableLauncherSha256}"
Root: HKCU; Subkey: "{#ApprovedUninstallKey}"; ValueType: string; ValueName: "LiftoffCertificateSha256"; ValueData: "{#ApprovedCertificateSha256}"
Root: HKCU; Subkey: "{#ApprovedUninstallKey}"; ValueType: string; ValueName: "LiftoffPathEntry"; ValueData: "{app}\bin"
Root: HKCU; Subkey: "{#ApprovedUninstallKey}"; ValueType: string; ValueName: "LiftoffPathAdded"; ValueData: "{code:OwnedPathAddition}"

[Icons]
Name: "{userprograms}\Liftoff"; Filename: "{app}\bin\liftoff.exe"

[Messages]
WindowsVersionNotSupported=Liftoff requires native Windows x64, Windows 10 build 14393 or newer. No existing installation will be changed.

[Code]
type
  TNativeFileInformation = record
    Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
      WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow: LongWord;
  end;

var
  OriginalPath, NextPath, PreviousPathAdded: String;
  OriginalPathType: LongWord;
  AddPath, RemovePath: Boolean;

function NativeFileAttributes(const FileName: String): LongWord;
  external 'GetFileAttributesW@kernel32.dll stdcall';
function NativeOpenFile(const FileName: String; Access, Share, Security, Creation, Flags, Template: LongWord): LongWord;
  external 'CreateFileW@kernel32.dll stdcall';
function NativeCloseFile(Handle: LongWord): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function NativeFileInformation(Handle: LongWord; var Information: TNativeFileInformation): Boolean;
  external 'GetFileInformationByHandle@kernel32.dll stdcall';
function NativeOpenKey(Root: LongWord; const Subkey: String; Options, Access: LongWord; var Key: LongWord): LongInt;
  external 'RegOpenKeyExW@advapi32.dll stdcall';
function NativeQueryValue(Key: LongWord; const Name: String; Reserved: LongWord; var Kind: LongWord; Data: LongWord; var Size: LongWord): LongInt;
  external 'RegQueryValueExW@advapi32.dll stdcall';
function NativeCloseKey(Key: LongWord): LongInt;
  external 'RegCloseKey@advapi32.dll stdcall';

function OwnerKey: String;
begin
  Result := ExpandConstant('{#ApprovedUninstallKey}');
end;

function PlainAncestors(Name: String): Boolean;
var
  Parent: String;
  Attributes: LongWord;
begin
  Result := False;
  if (Length(Name) < 3) or (Name[2] <> ':') or (Name[3] <> '\') then exit;
  repeat
    Attributes := NativeFileAttributes(Name);
    if (Attributes <> $FFFFFFFF) and ((Attributes and $400) <> 0) then exit;
    Parent := ExtractFileDir(Name);
    if Parent = Name then break;
    Name := Parent;
  until Name = '';
  Result := True;
end;

function PlainTree(const Directory: String; Depth: Integer; var Count: Integer): Boolean;
var
  Found: TFindRec;
  Name: String;
  Handle: LongWord;
  Information: TNativeFileInformation;
begin
  Result := False;
  if (Depth > 32) or not PlainAncestors(Directory) or not FindFirst(Directory + '\*', Found) then exit;
  try
    repeat
      if (Found.Name <> '.') and (Found.Name <> '..') then begin
        Count := Count + 1;
        if (Count > 100000) or ((Found.Attributes and $400) <> 0) then exit;
        Name := Directory + '\' + Found.Name;
        if (Found.Attributes and $10) <> 0 then begin
          if not PlainTree(Name, Depth + 1, Count) then exit;
        end else begin
          Handle := NativeOpenFile(Name, $80, 7, 0, 3, $00200000, 0);
          if Handle = $FFFFFFFF then exit;
          try
            if not NativeFileInformation(Handle, Information) or (Information.Links <> 1) or
              ((Information.Attributes and $410) <> 0) then exit;
          finally
            NativeCloseFile(Handle);
          end;
        end;
      end;
    until not FindNext(Found);
    Result := True;
  finally
    FindClose(Found);
  end;
end;

function EntryCount(const Value, Entry: String; Exact: Boolean): Integer;
var
  Parts: TArrayOfString;
  I: Integer;
begin
  Result := 0;
  Parts := StringSplit(Value, [';'], stAll);
  for I := 0 to GetArrayLength(Parts) - 1 do begin
    if Exact then begin
      if Parts[I] = Entry then Result := Result + 1;
    end else if CompareText(RemoveBackslashUnlessRoot(RemoveQuotes(Parts[I])), Entry) = 0 then
      Result := Result + 1;
  end;
end;

function UserPath(var Value: String; var Kind: LongWord): Boolean;
var
  Key, Size: LongWord;
  Status: LongInt;
begin
  Result := False;
  Value := '';
  Kind := 2;
  Status := NativeOpenKey($80000001, 'Environment', 0, 1, Key);
  if Status = 2 then begin Result := True; exit; end;
  if Status <> 0 then exit;
  Size := 0;
  Status := NativeQueryValue(Key, 'Path', 0, Kind, 0, Size);
  NativeCloseKey(Key);
  if Status = 2 then begin Kind := 2; Result := True; exit; end;
  if (Status <> 0) or ((Kind <> 1) and (Kind <> 2)) or (Size > 65534) then exit;
  Result := RegQueryStringValue(HKCU, 'Environment', 'Path', Value);
  if Result then Result := Size = (Length(Value) + 1) * 2;
end;

function ExistingOwner: Boolean;
var
  Digest, Publisher, Certificate, Location: String;
begin
  Result := RegQueryStringValue(HKCU, OwnerKey, 'Publisher', Publisher) and
    (Publisher = ExpandConstant('{#ApprovedPublisherPascal}')) and
    RegQueryStringValue(HKCU, OwnerKey, 'InstallLocation', Location) and
    (RemoveBackslashUnlessRoot(Location) = ExpandConstant('{app}')) and
    RegQueryStringValue(HKCU, OwnerKey, 'LiftoffCertificateSha256', Certificate) and
    (Certificate = '{#ApprovedCertificateSha256}');
  if not Result then exit;
  Result := RegQueryStringValue(HKCU, OwnerKey, 'LiftoffReceiptSha256', Digest) and
    (Length(Digest) = 64) and FileExists(ExpandConstant('{app}\native-install.json'));
  if not Result then exit;
  Result := GetSHA256OfFile(ExpandConstant('{app}\native-install.json')) = Digest;
  if not Result then exit;
  Result := RegQueryStringValue(HKCU, OwnerKey, 'LiftoffCurrentSha256', Digest) and
    (Length(Digest) = 64) and FileExists(ExpandConstant('{app}\current.txt'));
  if not Result then exit;
  Result := GetSHA256OfFile(ExpandConstant('{app}\current.txt')) = Digest;
  if not Result then exit;
  Result := RegQueryStringValue(HKCU, OwnerKey, 'LiftoffLauncherSha256', Digest) and
    (Length(Digest) = 64) and FileExists(ExpandConstant('{app}\bin\liftoff.exe'));
  if not Result then exit;
  Result := GetSHA256OfFile(ExpandConstant('{app}\bin\liftoff.exe')) = Digest;
end;

function LauncherClosed: Boolean;
var
  Handle: LongWord;
begin
  Result := True;
  if not FileExists(ExpandConstant('{app}\bin\liftoff.exe')) then exit;
  Handle := NativeOpenFile(ExpandConstant('{app}\bin\liftoff.exe'), $40000000, 0, 0, 3, $00200000, 0);
  Result := Handle <> $FFFFFFFF;
  if Result then NativeCloseFile(Handle);
end;

function AppendUserPath: Boolean;
begin
  Result := AddPath;
end;

function ReviewedUserPath(Param: String): String;
var
  Current: String;
  Kind: LongWord;
begin
  if not UserPath(Current, Kind) or (Current <> OriginalPath) or (Kind <> OriginalPathType) then
    RaiseException('The reviewed user PATH changed. No replacement PATH is authorized.');
  Result := NextPath;
end;

function OwnedPathAddition(Param: String): String;
begin
  if AddPath then Result := '1' else Result := PreviousPathAdded;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Found: TFindRec;
  Extension, Existing: String;
  I, Count: Integer;
begin
  Result := 'The selected user installation path or ownership is unsafe. No existing installation will be overwritten.';
  if (ExpandConstant('{app}') <> ExpandConstant('{localappdata}\Programs\Liftoff')) or
    (Pos(';', ExpandConstant('{app}')) > 0) or not PlainAncestors(ExpandConstant('{app}')) then exit;
  if not PlainAncestors(ExpandConstant('{app}\bin\liftoff.exe')) or
    not PlainAncestors(ExpandConstant('{app}\native-install.json')) or
    not PlainAncestors(ExpandConstant('{app}\current.txt')) or
    not PlainAncestors(ExpandConstant('{app}\versions\{#VersionName}')) then exit;
  PreviousPathAdded := '0';
  if RegKeyExists(HKCU, OwnerKey) then begin
    if not ExistingOwner or not RegQueryStringValue(HKCU, OwnerKey, 'LiftoffPathAdded', PreviousPathAdded) or
      ((PreviousPathAdded <> '0') and (PreviousPathAdded <> '1')) then exit;
  end;
  if DirExists(ExpandConstant('{app}')) then begin
    Count := 0;
    if not PlainTree(ExpandConstant('{app}'), 0, Count) then exit;
    if not RegKeyExists(HKCU, OwnerKey) and FindFirst(ExpandConstant('{app}\*'), Found) then begin
      try
        repeat
          if (Found.Name <> '.') and (Found.Name <> '..') then exit;
        until not FindNext(Found);
      finally
        FindClose(Found);
      end;
    end;
  end;
  if DirExists(ExpandConstant('{app}\versions\{#VersionName}')) or
    FileExists(ExpandConstant('{app}\versions\{#VersionName}')) then begin
    Result := 'This exact immutable Liftoff version already exists. Retain it; do not overwrite it.';
    exit;
  end;
  if not LauncherClosed then begin
    Result := 'Liftoff is running or its launcher cannot be exclusively opened. Exit Liftoff, then retry the same reviewed installer.';
    exit;
  end;
  for I := 0 to 3 do begin
    case I of 0: Extension := '.exe'; 1: Extension := '.com'; 2: Extension := '.cmd'; 3: Extension := '.bat'; end;
    Existing := FileSearch('liftoff' + Extension, GetEnv('PATH'));
    if (Existing <> '') and (CompareText(Existing, ExpandConstant('{app}\bin\liftoff.exe')) <> 0) then begin
      Result := 'Another Liftoff command is selected by PATH. Resolve that installation separately; this installer will not remove it.';
      exit;
    end;
  end;
  Result := 'The user PATH cannot be safely observed.';
  if not UserPath(OriginalPath, OriginalPathType) then exit;
  if (PreviousPathAdded = '1') and (EntryCount(OriginalPath, ExpandConstant('{app}\bin'), False) > 0) and
    ((EntryCount(OriginalPath, ExpandConstant('{app}\bin'), False) <> 1) or
      (EntryCount(OriginalPath, ExpandConstant('{app}\bin'), True) <> 1)) then begin
    Result := 'The previously owned PATH entry changed or was duplicated. Reconcile its attribution before upgrading.';
    exit;
  end;
  AddPath := EntryCount(OriginalPath, ExpandConstant('{app}\bin'), False) = 0;
  NextPath := OriginalPath;
  if AddPath then begin
    if (NextPath <> '') and (NextPath[Length(NextPath)] <> ';') then NextPath := NextPath + ';';
    NextPath := NextPath + ExpandConstant('{app}\bin');
    if Length(NextPath) > 32766 then exit;
  end;
  Result := '';
end;

function ReviewUninstall: Boolean;
var
  Added, Entry: String;
  Parts: TArrayOfString;
  I, Start, Count: Integer;
begin
  Result := False;
  Count := 0;
  if not PlainAncestors(ExpandConstant('{app}\bin\liftoff.exe')) or
    not PlainAncestors(ExpandConstant('{app}\native-install.json')) or
    not PlainAncestors(ExpandConstant('{app}\current.txt')) or
    not PlainTree(ExpandConstant('{app}'), 0, Count) or
    not ExistingOwner or not LauncherClosed then begin
    Log('Uninstall refused: installation ownership changed or Liftoff is still running.');
    exit;
  end;
  if not RegQueryStringValue(HKCU, OwnerKey, 'LiftoffPathAdded', Added) or
    not RegQueryStringValue(HKCU, OwnerKey, 'LiftoffPathEntry', Entry) or
    (Entry <> ExpandConstant('{app}\bin')) then exit;
  RemovePath := Added = '1';
  if RemovePath then begin
    if not UserPath(OriginalPath, OriginalPathType) then exit;
    if EntryCount(OriginalPath, Entry, False) <> EntryCount(OriginalPath, Entry, True) then begin
      Log('Uninstall refused: the attributable PATH entry was edited. Retain it for explicit reconciliation.');
      exit;
    end;
    if EntryCount(OriginalPath, Entry, True) > 1 then begin
      Log('Uninstall refused: duplicated PATH entries have ambiguous attribution.');
      exit;
    end;
    NextPath := OriginalPath;
    Parts := StringSplit(OriginalPath, [';'], stAll);
    Start := 1;
    for I := 0 to GetArrayLength(Parts) - 1 do begin
      if Parts[I] = Entry then begin
        if Start > 1 then Delete(NextPath, Start - 1, Length(Entry) + 1)
        else if Length(NextPath) > Length(Entry) then Delete(NextPath, Start, Length(Entry) + 1)
        else NextPath := '';
        break;
      end;
      Start := Start + Length(Parts[I]) + 1;
    end;
    RemovePath := NextPath <> OriginalPath;
  end else if Added <> '0' then exit;
  Result := True;
end;

function InitializeUninstall: Boolean;
begin
  Result := ReviewUninstall;
  if not Result then
    SuppressibleMsgBox('Liftoff uninstall was refused: ownership, file locking, or PATH attribution could not be safely verified. Retain the installation and inspect the uninstall log.', mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Current: String;
  Kind: LongWord;
  Written: Boolean;
  Count: Integer;
begin
  if CurUninstallStep <> usUninstall then exit;
  Count := 0;
  if not PlainTree(ExpandConstant('{app}'), 0, Count) or not ExistingOwner or not LauncherClosed then
    RaiseException('Uninstall refused: installation ownership or running-image state changed after review.');
  if not RemovePath then exit;
  if not UserPath(Current, Kind) or (Current <> OriginalPath) or (Kind <> OriginalPathType) then
    RaiseException('Uninstall refused: user PATH changed after review.');
  if Kind = 1 then Written := RegWriteStringValue(HKCU, 'Environment', 'Path', NextPath)
  else Written := RegWriteExpandStringValue(HKCU, 'Environment', 'Path', NextPath);
  if not Written then RaiseException('Uninstall refused: the exact owned PATH entry could not be removed.');
end;
