export const darwinStateSystemProgram = String.raw`
import base64, ctypes, json, os, platform, plistlib, re, stat, subprocess, sys

def response(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")

def keychain(reference, secret):
    filename = reference["keychainPath"]
    entry = os.lstat(filename)
    if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_mode & 0o077:
        raise ValueError("private keychain required")
    if os.path.realpath(filename) != filename:
        raise ValueError("canonical keychain required")
    security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    security.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_ubyte]
    security.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
    security.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainOpen.restype = ctypes.c_int32
    security.SecKeychainFindGenericPassword.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    security.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    security.SecKeychainItemFreeContent.restype = ctypes.c_int32
    core.CFRelease.argtypes = [ctypes.c_void_p]
    if security.SecKeychainSetUserInteractionAllowed(0) != 0:
        raise ValueError("noninteractive access unavailable")
    chain = ctypes.c_void_p()
    item = ctypes.c_void_p()
    data = ctypes.c_void_p()
    length = ctypes.c_uint32()
    if security.SecKeychainOpen(os.fsencode(filename), ctypes.byref(chain)) != 0:
        raise ValueError("keychain unavailable")
    service, account = reference["service"].encode(), reference["account"].encode()
    try:
        result = security.SecKeychainFindGenericPassword(chain, len(service), service, len(account), account,
            ctypes.byref(length) if secret else None, ctypes.byref(data) if secret else None, ctypes.byref(item))
        if result != 0:
            raise ValueError("item unavailable")
        if not secret:
            return {"ok": True, "present": True, "uid": os.getuid()}
        if length.value > 16384:
            raise ValueError("item exceeds bound")
        raw = ctypes.string_at(data, length.value)
        return {"ok": True, "value": base64.b64encode(raw).decode("ascii"), "uid": os.getuid()}
    finally:
        if data.value:
            ctypes.memset(data, 0, length.value)
            security.SecKeychainItemFreeContent(None, data)
        if item.value:
            core.CFRelease(item)
        if chain.value:
            core.CFRelease(chain)

try:
    if sys.platform != "darwin":
        raise ValueError("unsupported platform")
    request = json.loads(sys.stdin.buffer.read(16385))
    if request["operation"] == "volume":
        directory = request["directory"]
        entry = os.lstat(directory)
        if not stat.S_ISDIR(entry.st_mode) or os.path.realpath(directory) != directory:
            raise ValueError("canonical directory required")
        output = subprocess.run(["/bin/df", "-P", directory], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10).stdout
        lines = output.decode("utf8").strip().splitlines()
        if len(lines) != 2:
            raise ValueError("ambiguous mount")
        device = lines[1].split()[0]
        if not re.fullmatch(r"/dev/disk[0-9]+(?:s[0-9]+)*", device):
            raise ValueError("unsupported filesystem")
        raw = subprocess.run(["/usr/sbin/diskutil", "info", "-plist", device], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10).stdout
        if len(raw) > 1048576:
            raise ValueError("metadata bound")
        volume = plistlib.loads(raw)
        if volume.get("DeviceNode") != device or os.stat(directory).st_dev != entry.st_dev:
            raise ValueError("mount changed")
        acl = subprocess.run(["/bin/ls", "-lde", directory], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10).stdout.decode("utf8")
        acl_entries = sum(1 for line in acl.splitlines()[1:] if re.match(r"\s*\d+:", line))
        progress = [v for k,v in volume.items() if "progress" in k.lower() and ("encrypt" in k.lower() or "decrypt" in k.lower())]
        response({"ok": True, "canonicalDirectory": directory, "deviceNode": device,
            "volumeId": volume.get("VolumeUUID"), "filesystem": volume.get("FilesystemType"),
            "fileVault": volume.get("FileVault") is True,
            "encrypted": volume.get("Encryption") is True and volume.get("EncryptionThisVolumeProper") is True and not progress,
            "locked": volume.get("Locked") is not False, "ownerUid": entry.st_uid,
            "mode": stat.S_IMODE(entry.st_mode), "aclEntries": acl_entries})
    elif request["operation"] in ("keychain-metadata", "keychain-secret"):
        response(keychain(request["reference"], request["operation"] == "keychain-secret"))
    else:
        raise ValueError("unsupported operation")
except Exception:
    response({"ok": False, "code": "key-unavailable" if "keychain" in locals().get("request", {}).get("operation", "") else "protected-workspace-required"})
`;
