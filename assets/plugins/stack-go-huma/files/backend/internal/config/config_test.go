package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func environment(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}

func settingsFile(t *testing.T, content string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestDefaults(t *testing.T) {
	cfg, err := Load(environment(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg != Defaults() || cfg.Port != 8000 || cfg.DatabaseTimeout().Seconds() != 2 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestEnvironmentOverFileOverDefaults(t *testing.T) {
	cfg, err := Load(environment(map[string]string{
		FileVariable:       settingsFile(t, `{"port": 9000, "environment": "staging"}`),
		"APP_PORT":         "9100",
		"APP_DOCS_ENABLED": "false",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != 9100 || cfg.Environment != "staging" || cfg.DocsEnabled {
		t.Fatalf("unexpected precedence: %+v", cfg)
	}
}

func TestRejectsInvalidSettings(t *testing.T) {
	cases := map[string]struct {
		env  map[string]string
		want string
	}{
		"missing file":     {map[string]string{FileVariable: "missing.json"}, "does not exist"},
		"port text":        {map[string]string{"APP_PORT": "eighty"}, "port from APP_PORT"},
		"port range":       {map[string]string{"APP_PORT": "70000"}, "from 1 to 65535"},
		"timeout text":     {map[string]string{"APP_DATABASE_TIMEOUT_SECONDS": "soon"}, "seconds above 0"},
		"timeout zero":     {map[string]string{"APP_DATABASE_TIMEOUT_SECONDS": "0"}, "seconds above 0"},
		"docs flag":        {map[string]string{"APP_DOCS_ENABLED": "yes"}, "true or false"},
		"log level":        {map[string]string{"APP_LOG_LEVEL": "loud"}, "log_level must be one of"},
		"empty host":       {map[string]string{"APP_HOST": ""}, "host must be"},
		"empty env":        {map[string]string{"APP_ENVIRONMENT": ""}, "environment must be"},
		"empty url":        {map[string]string{"APP_DATABASE_URL": ""}, "database_url must be"},
		"malformed file":   {map[string]string{FileVariable: settingsFile(t, `{"port": `)}, "not a valid settings file"},
		"unknown settings": {map[string]string{FileVariable: settingsFile(t, `{"prot": 1}`)}, `unknown field "prot"`},
		"wrong type":       {map[string]string{FileVariable: settingsFile(t, `{"docs_enabled": "maybe"}`)}, "not a valid settings file"},
		"two objects":      {map[string]string{FileVariable: settingsFile(t, `{} {}`)}, "one JSON object"},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Load(environment(test.env))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("want an error containing %q, got %v", test.want, err)
			}
		})
	}
}
