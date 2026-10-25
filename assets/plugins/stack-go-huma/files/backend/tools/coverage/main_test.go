package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func profile(t *testing.T, content string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "cover.out")
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestCountsEachBlockOnce(t *testing.T) {
	// The same block reported by two packages' tests counts once, covered.
	file := profile(t, "mode: set\na.go:1.1,2.2 3 0\na.go:1.1,2.2 3 1\nb.go:1.1,2.2 1 0\n")
	var out strings.Builder
	if err := check([]string{file, "75"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "75.0% (3 of 4)") {
		t.Fatalf("unexpected report: %s", out.String())
	}
	if err := check([]string{file, "80"}, io.Discard); err == nil || !strings.Contains(err.Error(), "below 80.0%") {
		t.Fatalf("passed below the minimum: %v", err)
	}
}

func TestRejectsBadInput(t *testing.T) {
	cases := map[string][]string{
		"usage":       {},
		"minimum":     {profile(t, "mode: set\n"), "most"},
		"missing":     {filepath.Join(t.TempDir(), "none.out"), "80"},
		"empty":       {profile(t, "mode: set\n"), "80"},
		"not profile": {profile(t, "mode: set\nnonsense\n"), "80"},
		"bad counts":  {profile(t, "mode: set\na.go:1.1,2.2 x y\n"), "80"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			if err := check(args, io.Discard); err == nil {
				t.Fatal("accepted bad input")
			}
		})
	}
}
