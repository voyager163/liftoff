package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type launcherFixture struct {
	root       string
	executable string
	receipt    directReceipt
	image      []byte
}

func writeSourceFixture(t *testing.T, file string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, content, 0600); err != nil {
		t.Fatal(err)
	}
}

func jsonSourceFixture(t *testing.T, file string, value any) {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	writeSourceFixture(t, file, content)
}

func ownedSourceFixture(t *testing.T) launcherFixture {
	t.Helper()
	created, err := os.MkdirTemp(".", ".windows-launcher-source-")
	if err != nil {
		t.Fatal(err)
	}
	absolute, err := filepath.Abs(created)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := os.Lstat(scope)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		current, err := os.Lstat(scope)
		if err != nil || !os.SameFile(identity, current) {
			t.Error("created source-fixture identity changed; it was preserved")
			return
		}
		if err := os.RemoveAll(scope); err != nil {
			t.Error(err)
		}
	})
	root := filepath.Join(scope, "owned installation")
	executable := filepath.Join(root, "bin", "liftoff.exe")
	// These bytes exercise filesystem/receipt source logic, not Windows execution or signing.
	image := append([]byte("MZ source fixture, not a PE execution claim\n"), bytes.Repeat([]byte{0xa3}, 3*1024*1024)...)
	hash := sha256.Sum256(image)
	minimumBuild := 17763
	receipt := directReceipt{
		SchemaVersion: 1, Product: "liftoff", Version: "0.13.0", Target: nativeTarget(),
		InstalledAt: "2026-09-14T00:00:00.000Z", SourceCommit: strings.Repeat("7", 40),
		InstallRoot: root, VersionRoot: filepath.Join(root, "versions", "0.13.0-"+strings.Repeat("b", 16)),
		LauncherPath: executable, ChecksumSha256: strings.Repeat("c", 64),
		Runtime: nativeRuntime{NodeVersion: "24.20.0", MinimumHostVersion: "10.0.17763", MinimumBuild: &minimumBuild},
		Authority: directAuthority{
			ID: "10000000-0000-4000-8000-000000000001", ManifestDigest: strings.Repeat("d", 64),
			ProvenanceDigest: strings.Repeat("b", 64), LauncherSha256: hex.EncodeToString(hash[:]),
			Resources:       nativeResources{InventoryHash: strings.Repeat("e", 64), Count: 3},
			TransactionRoot: scope,
		},
	}
	value := launcherFixture{root: root, executable: executable, receipt: receipt, image: image}
	writeSourceFixture(t, executable, image)
	writePayloadFixture(t, receipt, image)
	jsonSourceFixture(t, filepath.Join(root, "liftoff-receipt.json"), receipt)
	return value
}

func writePayloadFixture(t *testing.T, receipt directReceipt, image []byte) {
	t.Helper()
	writeSourceFixture(t, filepath.Join(receipt.VersionRoot, "bin", "liftoff.exe"), image)
	writeSourceFixture(t, filepath.Join(receipt.VersionRoot, "runtime", "node.exe"), []byte("retained runtime source fixture"))
	writeSourceFixture(t, filepath.Join(receipt.VersionRoot, "dist", "cli.js"), []byte("retained application source fixture"))
	jsonSourceFixture(t, filepath.Join(receipt.VersionRoot, "liftoff-build-manifest.json"), nativeBuildManifest{
		SchemaVersion: 1, Product: receipt.Product, Version: receipt.Version, Target: receipt.Target,
		SourceCommit: receipt.SourceCommit, BuiltAt: receipt.InstalledAt, Runtime: receipt.Runtime,
		Resources: receipt.Authority.Resources,
	})
}

func TestReceiptPayloadActivationKeepsExactMappedImageAndOldPayload(t *testing.T) {
	value := ownedSourceFixture(t)
	before, err := os.Lstat(value.executable)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := resolvePayload(value.executable, nativeTarget())
	if err != nil || selected != value.receipt.VersionRoot {
		t.Fatalf("original source-fixture resolution: %q %v", selected, err)
	}
	next := value.receipt
	next.Version = "0.14.0"
	next.Authority.ProvenanceDigest = strings.Repeat("f", 64)
	next.VersionRoot = filepath.Join(value.root, "versions", "0.14.0-"+strings.Repeat("f", 16))
	writePayloadFixture(t, next, value.image)
	jsonSourceFixture(t, filepath.Join(value.root, "next-receipt.json"), next)
	if err := os.Rename(filepath.Join(value.root, "next-receipt.json"), filepath.Join(value.root, "liftoff-receipt.json")); err != nil {
		t.Fatal(err)
	}
	selected, err = resolvePayload(value.executable, nativeTarget())
	if err != nil || selected != next.VersionRoot {
		t.Fatalf("activated source-fixture resolution: %q %v", selected, err)
	}
	after, err := os.Lstat(value.executable)
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("receipt selection must not rewrite the stable image")
	}
	old, err := os.ReadFile(filepath.Join(value.receipt.VersionRoot, "runtime", "node.exe"))
	if err != nil || string(old) != "retained runtime source fixture" {
		t.Fatal("old payload was not retained exactly")
	}
}

func TestPortableVersionedLauncherCanRunWithoutSelectingStableImage(t *testing.T) {
	value := ownedSourceFixture(t)
	versioned := filepath.Join(value.receipt.VersionRoot, "bin", "liftoff.exe")
	selected, err := resolvePayload(versioned, nativeTarget())
	if err != nil || selected != value.receipt.VersionRoot {
		t.Fatalf("exact versioned launcher close/retry entrypoint: %q %v", selected, err)
	}
}

func TestRegisteredOptionalRuntimeFieldsRetainTheirReceiptMeaning(t *testing.T) {
	value := ownedSourceFixture(t)
	value.receipt.Runtime.MinimumBuild = nil
	writePayloadFixture(t, value.receipt, value.image)
	jsonSourceFixture(t, filepath.Join(value.root, "liftoff-receipt.json"), value.receipt)
	if selected, err := resolvePayload(value.executable, nativeTarget()); err != nil || selected != value.receipt.VersionRoot {
		t.Fatalf("registered host-version-only constraint was not preserved: %q %v", selected, err)
	}
	value.receipt.VersionRoot = filepath.Join(value.root, "versions", "explicit-owned-version-name")
	writePayloadFixture(t, value.receipt, value.image)
	jsonSourceFixture(t, filepath.Join(value.root, "liftoff-receipt.json"), value.receipt)
	if selected, err := resolvePayload(value.executable, nativeTarget()); err != nil || selected != value.receipt.VersionRoot {
		t.Fatalf("exact receipt ownership was inferred from a filename instead of its bound path: %q %v", selected, err)
	}
}

func TestDifferentCandidateImageNeverMasqueradesAsSelectedLauncher(t *testing.T) {
	value := ownedSourceFixture(t)
	changed := append([]byte(nil), value.image...)
	changed[len(changed)-1] ^= 1
	writeSourceFixture(t, filepath.Join(value.receipt.VersionRoot, "bin", "liftoff.exe"), changed)
	if _, err := resolvePayload(value.executable, nativeTarget()); err == nil {
		t.Fatal("an incompatible payload PE was accepted without actual stable PE replacement")
	}
	hash := sha256.Sum256(changed)
	value.receipt.Authority.LauncherSha256 = hex.EncodeToString(hash[:])
	jsonSourceFixture(t, filepath.Join(value.root, "liftoff-receipt.json"), value.receipt)
	if _, err := resolvePayload(value.executable, nativeTarget()); err == nil {
		t.Fatal("a new receipt alone was accepted for a different stable PE")
	}
	writeSourceFixture(t, value.executable, changed)
	if selected, err := resolvePayload(value.executable, nativeTarget()); err != nil || selected != value.receipt.VersionRoot {
		t.Fatalf("actual exact changed-image source replacement did not resolve: %q %v", selected, err)
	}
}

func TestRejectUnknownAmbiguousOrIncompleteReceiptAuthority(t *testing.T) {
	cases := []struct {
		name   string
		change func(*directReceipt)
	}{
		{"wrong-product", func(r *directReceipt) { r.Product = "other" }},
		{"future-schema", func(r *directReceipt) { r.SchemaVersion = 2 }},
		{"wrong-architecture", func(r *directReceipt) { r.Target = "win32-ia32" }},
		{"prerelease", func(r *directReceipt) { r.Version = "0.13.0-preview" }},
		{"owner-root", func(r *directReceipt) { r.InstallRoot = r.VersionRoot }},
		{"launcher-path", func(r *directReceipt) { r.LauncherPath = filepath.Join(r.InstallRoot, "liftoff.exe") }},
		{"missing-owner", func(r *directReceipt) { r.Authority.ID = "" }},
		{"missing-digest", func(r *directReceipt) { r.Authority.ProvenanceDigest = "" }},
		{"invalid-time", func(r *directReceipt) { r.InstalledAt = "yesterday" }},
		{"resource-inventory", func(r *directReceipt) { r.Authority.Resources.Count = 0 }},
		{"unconfined-transaction", func(r *directReceipt) { r.Authority.TransactionRoot = r.VersionRoot }},
		{"unconfined-payload", func(r *directReceipt) { r.VersionRoot = r.Authority.TransactionRoot }},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			value := ownedSourceFixture(t)
			item.change(&value.receipt)
			jsonSourceFixture(t, filepath.Join(value.root, "liftoff-receipt.json"), value.receipt)
			if _, err := resolvePayload(value.executable, nativeTarget()); err == nil {
				t.Fatal("invalid receipt source fixture was accepted")
			}
		})
	}
}

func TestStrictReceiptReaderRejectsDuplicateCaseAliasBooleanAndTrailingClaims(t *testing.T) {
	value := ownedSourceFixture(t)
	original, err := json.Marshal(value.receipt)
	if err != nil {
		t.Fatal(err)
	}
	cases := [][]byte{
		bytes.Replace(original, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1),
		bytes.Replace(original, []byte(`"schemaVersion":1`), []byte(`"SchemaVersion":1`), 1),
		bytes.Replace(original, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"approved":true`), 1),
		append(append([]byte(nil), original...), []byte(` {"approved":true}`)...),
		[]byte(`{"schemaVersion":1,"authority":null}`),
		append(append([]byte(nil), original...), 0xff),
	}
	for _, data := range cases {
		var receipt directReceipt
		if decodeStrict(data, &receipt) == nil {
			t.Fatal("unregistered JSON identity or approval claim was accepted")
		}
	}
}

func TestReceiptBuildMismatchAndMixedLayoutRemainBlocked(t *testing.T) {
	value := ownedSourceFixture(t)
	build := filepath.Join(value.receipt.VersionRoot, "liftoff-build-manifest.json")
	data, err := os.ReadFile(build)
	if err != nil {
		t.Fatal(err)
	}
	writeSourceFixture(t, build, bytes.Replace(data, []byte(`"version":"0.13.0"`), []byte(`"version":"0.14.0"`), 1))
	if _, err := resolvePayload(value.executable, nativeTarget()); err == nil {
		t.Fatal("mismatching build identity was accepted")
	}
	writeSourceFixture(t, build, data)
	writeSourceFixture(t, filepath.Join(value.root, "runtime", "node.exe"), []byte("ambiguous root runtime"))
	if _, err := resolvePayload(value.executable, nativeTarget()); err == nil {
		t.Fatal("ambiguous direct/portable layout was accepted")
	}
}

func TestMissingRedirectedAndOversizedFilesRemainBlocked(t *testing.T) {
	value := ownedSourceFixture(t)
	payload := filepath.Join(value.receipt.VersionRoot, "bin", "liftoff.exe")
	if err := os.Remove(payload); err != nil {
		t.Fatal(err)
	}
	if _, err := resolvePayload(value.executable, nativeTarget()); err == nil {
		t.Fatal("missing payload PE was accepted")
	}
	if err := os.Symlink(value.executable, payload); err != nil {
		t.Fatal(err)
	}
	if _, err := resolvePayload(value.executable, nativeTarget()); err == nil {
		t.Fatal("linked payload PE was accepted")
	}
	if _, err := readRegular(value.executable, 64*1024); err == nil {
		t.Fatal("oversized file escaped the selected byte bound")
	}
}
