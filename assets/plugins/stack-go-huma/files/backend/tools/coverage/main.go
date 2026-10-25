// Command coverage fails when a Go cover profile's statement coverage is
// below a minimum percentage:
//
//	go test -coverpkg=./cmd/...,./internal/... -coverprofile=cover.out ./...
//	go run ./tools/coverage cover.out 80
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

func main() {
	if err := check(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "coverage:", err)
		os.Exit(1)
	}
}

func check(args []string, out io.Writer) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: coverage PROFILE MINIMUM_PERCENT")
	}
	minimum, err := strconv.ParseFloat(args[1], 64)
	if err != nil {
		return fmt.Errorf("minimum %q is not a number", args[1])
	}
	file, err := os.Open(args[0])
	if err != nil {
		return err
	}
	defer file.Close()
	covered, total, err := statements(file)
	if err != nil {
		return err
	}
	if total == 0 {
		return fmt.Errorf("%s covers no statements", args[0])
	}
	percent := 100 * float64(covered) / float64(total)
	fmt.Fprintf(out, "statement coverage: %.1f%% (%d of %d), minimum %.1f%%\n", percent, covered, total, minimum)
	if percent < minimum {
		return fmt.Errorf("statement coverage %.1f%% is below %.1f%%", percent, minimum)
	}
	return nil
}

// statements counts each block once, covered if any package's tests ran it.
func statements(profile io.Reader) (covered, total int, err error) {
	type block struct {
		statements int
		ran        bool
	}
	blocks := map[string]*block{}
	scanner := bufio.NewScanner(profile)
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if line == 1 || text == "" {
			continue // the "mode:" header
		}
		// file.go:12.2,14.3 2 1  -> location, statements, count
		fields := strings.Fields(text)
		if len(fields) != 3 {
			return 0, 0, fmt.Errorf("line %d is not a cover profile line: %q", line, text)
		}
		count, err1 := strconv.Atoi(fields[2])
		size, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			return 0, 0, fmt.Errorf("line %d is not a cover profile line: %q", line, text)
		}
		b := blocks[fields[0]]
		if b == nil {
			b = &block{statements: size}
			blocks[fields[0]] = b
		}
		b.ran = b.ran || count > 0
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	for _, b := range blocks {
		total += b.statements
		if b.ran {
			covered += b.statements
		}
	}
	return covered, total, nil
}
