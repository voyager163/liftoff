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

[Setup]
AppId={#ApprovedAppId}
AppName=Liftoff
AppVersion={#PackageVersion}
AppPublisher={#ApprovedPublisher}
DefaultDirName={localappdata}\Programs\Liftoff
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.14393
DisableProgramGroupPage=yes
CloseApplications=no
RestartApplications=no
SignedUninstaller=yes
SignTool=liftoff
OutputBaseFilename=liftoff-{#PackageVersion}-win32-x64-setup
Compression=lzma2
SolidCompression=yes

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}\versions\{#PackageVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Liftoff"; Filename: "{app}\versions\{#PackageVersion}\bin\liftoff.exe"

[Messages]
WindowsVersionNotSupported=Liftoff requires native Windows x64, Windows 10 build 14393 or newer. No existing installation will be changed.

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if DirExists(ExpandConstant('{app}\versions\{#PackageVersion}')) then
    Result := 'This immutable Liftoff version already exists. Do not overwrite it or a running executable.';
end;
