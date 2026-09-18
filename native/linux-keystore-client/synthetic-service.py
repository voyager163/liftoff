"""Private, in-memory protocol fixture. Never a GNOME daemon or real keystore."""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import signal
import sys


def fail():
    os.write(2, b"synthetic-secret-service-failed\n")
    raise SystemExit(1)


def main():
    if sys.platform != "linux":
        fail()
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--address", required=True)
    parser.add_argument("--fault", choices=(
        "none", "plain", "prompt", "short-key", "duplicate-search",
        "duplicate-secrets", "wrong-secret-path", "changed-item", "post-write",
    ), required=True)
    parser.add_argument("--mode", choices=("read", "create"), required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--enrollment", required=True)
    args = parser.parse_args()
    if len(args.address) > 400 or not args.address.startswith("unix:path=") or ";" in args.address:
        fail()
    source = Path(args.source)
    if not source.is_absolute() or source.resolve() != source:
        fail()
    manifest = json.loads(Path(__file__).with_name("synthetic-dependencies.json").read_text())
    for filename, digest in manifest["upstreamMocks"].items():
        selected = source / filename
        if selected.resolve() != selected or hashlib.sha256(selected.read_bytes()).hexdigest() != digest:
            fail()
    # Import unchanged upstream LGPL test code from the exact checkout, not vendored crypto.
    # The upstream module parses argv at import; give it no untrusted command options.
    sys.argv = [__file__]
    cache = Path.cwd() / "unused-bytecode-cache"
    if cache.exists():
        fail()
    sys.pycache_prefix = str(cache)
    sys.path.insert(0, str(source / "libsecret"))
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib
    import mock
    from mock import service as upstream

    logging.disable(logging.CRITICAL)
    DBusGMainLoop(set_as_default=True)
    bus = dbus.bus.BusConnection(args.address)
    expected = {
        "xdg:schema": "org.liftoff.ManagedApplicationKey.v1",
        "liftoff.project": args.project,
        "liftoff.workspace": args.workspace,
        "liftoff.enrollment": args.enrollment,
    }
    audit = {
        "kind": "synthetic-source-fixture", "sessions": [], "creates": 0, "reads": 0,
        "searches": 0, "prompts": 0, "unexpected": 0, "replaceRequested": False,
        "attributesExact": True, "createdLength": 0,
    }

    def record():
        # No key bytes, ciphertext, password, key digest or arbitrary diagnostics are recorded.
        Path("audit.next").write_text(json.dumps(audit))
        os.replace("audit.next", "audit.json")

    def forbidden():
        audit["unexpected"] += 1
        record()
        raise upstream.NotSupported("synthetic-operation-forbidden")

    class FixturePrompt(mock.SecretPrompt):
        @dbus.service.method("org.freedesktop.Secret.Prompt", in_signature="s", out_signature="")
        def Prompt(self, window_id):
            audit["prompts"] += 1
            record()
            raise upstream.NotSupported("synthetic-prompt-must-not-run")

    class FixtureService(mock.SecretService):
        def __init__(self):
            # Do not call upstream's SessionBus constructor or add its desktop aliases.
            self.bus = bus
            dbus.service.Object.__init__(self, bus, "/org/freedesktop/secrets")
            self.sessions, self.prompts, self.collections = {}, {}, {}
            self.aliases, self.aliased = {}, {}
            self.algorithms = {"plain": mock.PlainAlgorithm()} if args.fault == "plain" else dict(upstream.SecretService.algorithms)

        @dbus.service.method("org.freedesktop.Secret.Service", in_signature="sv", out_signature="vo",
                             sender_keyword="sender", byte_arrays=True)
        def OpenSession(self, algorithm, param, sender=None):
            audit["sessions"].append("encrypted" if algorithm == "dh-ietf1024-sha256-aes128-cbc-pkcs7" else "plain")
            record()
            return super().OpenSession(algorithm, param, sender)

        @dbus.service.method("org.freedesktop.Secret.Service", in_signature="aoo", out_signature="a{o(oayays)}",
                             sender_keyword="sender")
        def GetSecrets(self, paths, session_path, sender=None):
            audit["reads"] += 1
            record()
            if len(paths) != 1 or str(paths[0]) not in self.collections[collection.path].items:
                return forbidden()
            result = super().GetSecrets(paths, session_path, sender)
            if args.fault == "duplicate-secrets":
                result[dbus.ObjectPath(collection.path + "/unexpected")] = result[paths[0]]
            if args.fault == "wrong-secret-path":
                result = dbus.Dictionary({dbus.ObjectPath(collection.path + "/unexpected"): result[paths[0]]},
                                         signature="o(oayays)")
            if args.fault == "changed-item":
                collection.items[str(paths[0])].modified += 1
            return result

        @dbus.service.method("org.freedesktop.Secret.Service", in_signature="ao", out_signature="aoo")
        def Unlock(self, paths):
            return forbidden()

        @dbus.service.method("org.freedesktop.Secret.Service", in_signature="a{sv}s", out_signature="oo")
        def CreateCollection(self, properties, alias):
            return forbidden()

        @dbus.service.method("org.freedesktop.Secret.Service", in_signature="a{ss}", out_signature="aoao")
        def SearchItems(self, attributes):
            return forbidden()

        @dbus.service.method("org.freedesktop.Secret.Service", in_signature="s", out_signature="o")
        def ReadAlias(self, name):
            return forbidden()

        @dbus.service.method("org.freedesktop.Secret.Service", in_signature="so", out_signature="")
        def SetAlias(self, name, value):
            return forbidden()

    class FixtureCollection(mock.SecretCollection):
        @dbus.service.method("org.freedesktop.Secret.Collection", in_signature="a{ss}", out_signature="ao")
        def SearchItems(self, attributes):
            audit["searches"] += 1
            if dict(attributes) != expected:
                audit["attributesExact"] = False
                record()
                return forbidden()
            record()
            return super().SearchItems(attributes)

        @dbus.service.method("org.freedesktop.Secret.Collection", in_signature="a{sv}(oayays)b",
                             out_signature="oo", sender_keyword="sender", byte_arrays=True)
        def CreateItem(self, properties, value, replace, sender=None):
            audit["creates"] += 1
            audit["replaceRequested"] = bool(replace)
            audit["attributesExact"] = (
                set(properties) == {"org.freedesktop.Secret.Item.Attributes", "org.freedesktop.Secret.Item.Label"}
                and dict(properties.get("org.freedesktop.Secret.Item.Attributes", {})) == expected
            )
            record()
            if replace or not audit["attributesExact"]:
                return forbidden()
            if args.fault == "prompt":
                prompt = FixturePrompt(self.service, sender, "forbidden")
                return dbus.ObjectPath("/"), dbus.ObjectPath(prompt.path)
            result = super().CreateItem(properties, value, replace, sender)
            item = self.items[str(result[0])]
            item.created = item.modified = int(item.created)
            audit["createdLength"] = len(item.secret)
            if args.fault == "post-write":
                item.attributes["unexpected-attribute"] = "synthetic"
            record()
            return result

    service = FixtureService()
    collection = FixtureCollection(service, "login", label="Synthetic source fixture only")
    collection.created = collection.modified = int(collection.created)
    if args.mode == "read":
        for identifier in (("1", "2") if args.fault == "duplicate-search" else ("1",)):
            item = mock.SecretItem(collection, identifier, attributes=dict(expected),
                                   secret=b"N" * (31 if args.fault == "short-key" else 32),
                                   content_type="application/octet-stream")
            item.created = item.modified = int(item.created)
    if bus.request_name("org.freedesktop.secrets", dbus.bus.NAME_FLAG_DO_NOT_QUEUE) != dbus.bus.REQUEST_NAME_REPLY_PRIMARY_OWNER:
        fail()
    stat = Path("/proc/self/stat").read_text()
    start = stat[stat.rfind(")") + 2:].split()[19]
    record()
    print(json.dumps({
        "kind": "synthetic-source-fixture", "pid": os.getpid(), "uid": os.getuid(),
        "sid": os.getsid(0), "start": start, "owner": bus.get_unique_name()
    }), flush=True)
    loop = GLib.MainLoop()
    for number in (signal.SIGTERM, signal.SIGINT):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, number, lambda: (loop.quit(), False)[1])
    loop.run()
    bus.close()


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt):
        fail()
