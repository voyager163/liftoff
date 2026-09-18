package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

const directLauncherABI = "liftoff-windows-launcher/1 receipt-bin/1"
const launcherLimit = 8 * 1024 * 1024

type nativeRuntime struct {
	NodeVersion          string  `json:"nodeVersion"`
	MinimumGlibc         *string `json:"minimumGlibc,omitempty"`
	MinimumKernelVersion *string `json:"minimumKernelVersion,omitempty"`
	MinimumHostVersion   string  `json:"minimumHostVersion"`
	MinimumDarwinRelease *string `json:"minimumDarwinRelease,omitempty"`
	MinimumBuild         *int    `json:"minimumBuild,omitempty"`
}

type nativeResources struct {
	InventoryHash string `json:"inventoryHash"`
	Count         int    `json:"count"`
}

type directAuthority struct {
	ID               string          `json:"id"`
	ManifestDigest   string          `json:"manifestDigest"`
	ProvenanceDigest string          `json:"provenanceDigest"`
	LauncherSha256   string          `json:"launcherSha256"`
	Resources        nativeResources `json:"resources"`
	TransactionRoot  string          `json:"transactionRoot"`
}

type directReceipt struct {
	SchemaVersion  int             `json:"schemaVersion"`
	Product        string          `json:"product"`
	Version        string          `json:"version"`
	Target         string          `json:"target"`
	InstalledAt    string          `json:"installedAt"`
	SourceCommit   string          `json:"sourceCommit"`
	InstallRoot    string          `json:"installRoot"`
	VersionRoot    string          `json:"versionRoot"`
	LauncherPath   string          `json:"launcherPath"`
	Runtime        nativeRuntime   `json:"runtime"`
	ChecksumSha256 string          `json:"checksumSha256"`
	Authority      directAuthority `json:"authority"`
}

type nativeBuildManifest struct {
	SchemaVersion int             `json:"schemaVersion"`
	Product       string          `json:"product"`
	Version       string          `json:"version"`
	Target        string          `json:"target"`
	SourceCommit  string          `json:"sourceCommit"`
	BuiltAt       string          `json:"builtAt"`
	Runtime       nativeRuntime   `json:"runtime"`
	Resources     nativeResources `json:"resources"`
}

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[A-Za-z0-9.-]+)?$`)
var commitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var authorityPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

func fail(message string) {
	_, _ = os.Stderr.WriteString("Liftoff launcher: " + message + "\r\n")
	os.Exit(126)
}

func nativeTarget() string {
	switch runtime.GOARCH {
	case "amd64":
		return "win32-x64"
	case "arm64":
		return "win32-arm64"
	default:
		return ""
	}
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func canonicalPath(file string) error {
	if !filepath.IsAbs(file) || filepath.Clean(file) != file ||
		strings.HasPrefix(file, `\\`) || strings.ContainsAny(file, "\x00\r\n") {
		return errors.New("noncanonical or remote native path")
	}
	resolved, err := filepath.EvalSymlinks(file)
	if err != nil || !samePath(resolved, file) {
		return errors.New("missing or redirected native path")
	}
	for current := file; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil || info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return errors.New("linked or unavailable native path")
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	return nil
}

func readRegular(file string, maximum int64) ([]byte, error) {
	if err := canonicalPath(file); err != nil {
		return nil, err
	}
	before, err := os.Lstat(file)
	if err != nil || !before.Mode().IsRegular() || before.Size() < 1 || before.Size() > maximum {
		return nil, errors.New("missing or oversized regular native file")
	}
	handle, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	opened, err := handle.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return nil, errors.New("native file changed while opening")
	}
	content, err := io.ReadAll(io.LimitReader(handle, maximum+1))
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(file)
	if err != nil || !os.SameFile(opened, after) || after.Mode() != opened.Mode() ||
		after.Size() != opened.Size() || int64(len(content)) != opened.Size() ||
		!after.ModTime().Equal(opened.ModTime()) || canonicalPath(file) != nil {
		return nil, errors.New("native file changed while reading")
	}
	return content, nil
}

func uniqueJSON(decoder *json.Decoder, depth int) error {
	if depth > 12 {
		return errors.New("native metadata nesting is excessive")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delim, ok := token.(json.Delim); ok {
		if delim != '{' {
			return errors.New("native launcher metadata requires objects, not arrays")
		}
		seen := make(map[string]bool)
		for decoder.More() {
			key, err := decoder.Token()
			name, ok := key.(string)
			if err != nil || !ok || seen[name] {
				return errors.New("duplicate or invalid native metadata field")
			}
			seen[name] = true
			if len(seen) > 32 {
				return errors.New("native metadata field inventory is excessive")
			}
			if err := uniqueJSON(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("incomplete native metadata")
		}
	}
	return nil
}

func exactFields(data []byte, shape reflect.Type) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || len(fields) > shape.NumField() {
		return errors.New("native metadata has missing or unregistered fields")
	}
	known := make(map[string]bool)
	for i := 0; i < shape.NumField(); i++ {
		name, _, _ := strings.Cut(shape.Field(i).Tag.Get("json"), ",")
		known[name] = true
	}
	for name := range fields {
		if !known[name] {
			return errors.New("native metadata contains an unregistered field")
		}
	}
	for i := 0; i < shape.NumField(); i++ {
		field := shape.Field(i)
		name, option, _ := strings.Cut(field.Tag.Get("json"), ",")
		value, ok := fields[name]
		if !ok && option == "omitempty" {
			continue
		}
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("native metadata field is missing or null")
		}
		if field.Type.Kind() == reflect.Struct {
			if err := exactFields(value, field.Type); err != nil {
				return err
			}
		}
	}
	return nil
}

func decodeStrict(data []byte, target any) error {
	if !utf8.Valid(data) {
		return errors.New("native metadata is not UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := uniqueJSON(decoder, 0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("native metadata has trailing input")
	}
	if err := exactFields(data, reflect.TypeOf(target).Elem()); err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func childOf(root, file string) bool {
	relative, err := filepath.Rel(root, file)
	return err == nil && relative != "." && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func resolvePayload(executable, target string) (string, error) {
	if target == "" || canonicalPath(executable) != nil {
		return "", errors.New("cannot resolve its owned executable")
	}
	root := filepath.Dir(filepath.Dir(executable))
	if !samePath(executable, filepath.Join(root, "bin", "liftoff.exe")) {
		return "", errors.New("launcher is outside its registered bin layout")
	}
	receiptPath := filepath.Join(root, "liftoff-receipt.json")
	_, err := os.Lstat(receiptPath)
	if os.IsNotExist(err) {
		if _, err := readRegular(filepath.Join(root, "liftoff-build-manifest.json"), 64*1024); err != nil {
			return "", errors.New("neither a complete portable bundle nor a direct receipt is present")
		}
		return root, nil
	}
	if err != nil {
		return "", errors.New("direct receipt is unavailable; portable fallback is not authorized")
	}
	for _, entry := range []string{"runtime", "dist", "liftoff-build-manifest.json"} {
		if _, err := os.Lstat(filepath.Join(root, entry)); !os.IsNotExist(err) {
			return "", errors.New("ambiguous portable and direct installation layouts")
		}
	}
	original, err := readRegular(receiptPath, 2*1024*1024)
	if err != nil {
		return "", err
	}
	var receipt directReceipt
	if err := decodeStrict(original, &receipt); err != nil {
		return "", err
	}
	if receipt.SchemaVersion != 1 || receipt.Product != "liftoff" || receipt.Target != target ||
		!versionPattern.MatchString(receipt.Version) || !versionPattern.MatchString(receipt.Runtime.NodeVersion) ||
		!commitPattern.MatchString(receipt.SourceCommit) || !authorityPattern.MatchString(receipt.Authority.ID) ||
		receipt.Runtime.MinimumBuild != nil && (*receipt.Runtime.MinimumBuild < 17763 || *receipt.Runtime.MinimumBuild > 999999) ||
		receipt.Runtime.MinimumHostVersion == "" ||
		receipt.Authority.Resources.Count < 1 || receipt.Authority.Resources.Count > 16384 ||
		!samePath(receipt.InstallRoot, root) || !samePath(receipt.LauncherPath, executable) {
		return "", errors.New("direct receipt does not identify this native installation")
	}
	if installed, err := time.Parse("2006-01-02T15:04:05.000Z", receipt.InstalledAt); err != nil ||
		installed.Format("2006-01-02T15:04:05.000Z") != receipt.InstalledAt {
		return "", errors.New("direct receipt has an invalid installation time")
	}
	for _, digest := range []string{receipt.ChecksumSha256, receipt.Authority.ManifestDigest,
		receipt.Authority.ProvenanceDigest, receipt.Authority.LauncherSha256, receipt.Authority.Resources.InventoryHash} {
		if !digestPattern.MatchString(digest) {
			return "", errors.New("direct receipt is missing an exact native identity")
		}
	}
	if canonicalPath(receipt.Authority.TransactionRoot) != nil ||
		!childOf(receipt.Authority.TransactionRoot, root) || canonicalPath(receipt.VersionRoot) != nil ||
		!samePath(filepath.Dir(receipt.VersionRoot), filepath.Join(root, "versions")) {
		return "", errors.New("direct payload or transaction boundary is not confined")
	}
	image, err := readRegular(executable, launcherLimit)
	if err != nil {
		return "", err
	}
	imageHash := sha256.Sum256(image)
	if hex.EncodeToString(imageHash[:]) != receipt.Authority.LauncherSha256 {
		return "", errors.New("stable PE replacement is incomplete; use recorded close/handover recovery")
	}
	payloadImage, err := readRegular(filepath.Join(receipt.VersionRoot, "bin", "liftoff.exe"), launcherLimit)
	if err != nil || !bytes.Equal(image, payloadImage) {
		return "", errors.New("stable PE differs from the exact selected payload launcher")
	}
	manifestBytes, err := readRegular(filepath.Join(receipt.VersionRoot, "liftoff-build-manifest.json"), 64*1024)
	if err != nil {
		return "", err
	}
	var manifest nativeBuildManifest
	if err := decodeStrict(manifestBytes, &manifest); err != nil {
		return "", err
	}
	if manifest.SchemaVersion != 1 || manifest.Product != receipt.Product || manifest.Version != receipt.Version ||
		manifest.Target != receipt.Target || manifest.SourceCommit != receipt.SourceCommit ||
		!reflect.DeepEqual(manifest.Runtime, receipt.Runtime) || manifest.Resources != receipt.Authority.Resources {
		return "", errors.New("selected payload build identity differs from the direct receipt")
	}
	current, err := readRegular(receiptPath, 2*1024*1024)
	if err != nil || !bytes.Equal(current, original) {
		return "", errors.New("direct selection changed while resolving its payload; retry after handover settles")
	}
	return receipt.VersionRoot, nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--liftoff-native-launcher-abi" && nativeTarget() != "" {
		_, _ = fmt.Fprintf(os.Stdout, "%s %s\r\n", directLauncherABI, nativeTarget())
		return
	}
	executable, err := os.Executable()
	if err != nil {
		fail("cannot observe its executable")
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		fail("cannot resolve its owned executable")
	}
	root, err := resolvePayload(executable, nativeTarget())
	if err != nil {
		fail(err.Error())
	}
	privateRuntime := filepath.Join(root, "runtime", "node.exe")
	cli := filepath.Join(root, "dist", "cli.js")
	for _, file := range []string{privateRuntime, cli} {
		info, err := os.Lstat(file)
		if err != nil || !info.Mode().IsRegular() || canonicalPath(file) != nil {
			fail("required private runtime or CLI is missing or linked")
		}
	}
	env := make([]string, 0, len(os.Environ()))
	seen := make(map[string]bool)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		if seen[upper] {
			fail("ambiguous environment aliases")
		}
		seen[upper] = true
		if upper == "NODE_OPTIONS" || upper == "NODE_PATH" || upper == "NODE_EXTRA_CA_CERTS" ||
			upper == "NODE_ICU_DATA" || upper == "NODE_V8_COVERAGE" || upper == "NODE_REPL_EXTERNAL_MODULE" ||
			upper == "NODE_TLS_REJECT_UNAUTHORIZED" || upper == "OPENSSL_CONF" || upper == "OPENSSL_MODULES" ||
			upper == "OPENSSL_ENGINES" || upper == "BASH_ENV" || upper == "ENV" ||
			strings.HasPrefix(upper, "LD_") || strings.HasPrefix(upper, "DYLD_") {
			continue
		}
		env = append(env, entry)
	}
	command := exec.Command(privateRuntime, append([]string{cli}, os.Args[1:]...)...)
	command.Env = env
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Windows delivers console interrupts to the child too; retain the launcher until it settles.
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	if err := command.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() >= 0 {
			os.Exit(exit.ExitCode())
		}
		fail("private runtime could not execute or settle")
	}
}
