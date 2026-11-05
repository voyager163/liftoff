// Package config reads the API's runtime configuration.
//
// Settings come from, in order of precedence:
//
//  1. process environment variables, prefixed APP_ (for example APP_PORT);
//  2. the JSON file named by APP_CONFIG_FILE, when that variable is set;
//  3. the non-secret defaults below.
//
// Naming a configuration file that is missing, malformed or contains unknown
// settings is an error. It never falls back to the defaults silently.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"time"
)

// FileVariable names the environment variable that selects a configuration file.
const FileVariable = "APP_CONFIG_FILE"

// LogLevels are the accepted values of log_level.
var LogLevels = []string{"debug", "info", "warn", "error"}

// The accepted range of database_timeout_seconds.
const (
	MinDatabaseTimeoutSeconds = 0.001
	MaxDatabaseTimeoutSeconds = 86400.0
)

// Config is the API's configuration. The JSON names are the setting names in
// the configuration file; the environment uses APP_ plus the upper-case name.
type Config struct {
	Environment string `json:"environment"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	// No password here: provide the full URL through APP_DATABASE_URL.
	DatabaseURL            string  `json:"database_url"`
	DatabaseTimeoutSeconds float64 `json:"database_timeout_seconds"`
	DocsEnabled            bool    `json:"docs_enabled"`
	LogLevel               string  `json:"log_level"`
}

// Defaults are the settings used when nothing else is given.
func Defaults() Config {
	return Config{
		Environment:            "local",
		Host:                   "127.0.0.1",
		Port:                   8000,
		DatabaseURL:            "postgresql://postgres@localhost:5432/app",
		DatabaseTimeoutSeconds: 2,
		DocsEnabled:            true,
		LogLevel:               "info",
	}
}

// DatabaseTimeout is DatabaseTimeoutSeconds as a duration.
func (c Config) DatabaseTimeout() time.Duration {
	return time.Duration(c.DatabaseTimeoutSeconds * float64(time.Second))
}

// Load reads the configuration; lookup is os.LookupEnv outside tests.
func Load(lookup func(string) (string, bool)) (Config, error) {
	cfg := Defaults()
	if file, ok := lookup(FileVariable); ok && file != "" {
		if err := readFile(file, &cfg); err != nil {
			return Config{}, err
		}
	}
	if err := applyEnvironment(lookup, &cfg); err != nil {
		return Config{}, err
	}
	return cfg, validate(cfg)
}

func readFile(file string, cfg *Config) error {
	content, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("%s names %s, which does not exist or cannot be read", FileVariable, file)
	}
	// Decoding JSON null leaves a setting unchanged, so a null file or setting
	// would silently keep the default; both are rejected first.
	var settings map[string]json.RawMessage
	if err := strictDecode(content, &settings); err != nil {
		return fmt.Errorf("%s is not a valid settings file: %w", file, err)
	}
	if settings == nil {
		return fmt.Errorf("%s must hold one JSON object of settings", file)
	}
	var nulls []string
	for name, value := range settings {
		if string(bytes.TrimSpace(value)) == "null" {
			nulls = append(nulls, name)
		}
	}
	if len(nulls) > 0 {
		slices.Sort(nulls)
		return fmt.Errorf("%s sets %v to null; remove a setting to use its default", file, nulls)
	}
	if err := strictDecode(content, cfg); err != nil {
		return fmt.Errorf("%s is not a valid settings file: %w", file, err)
	}
	return nil
}

// strictDecode decodes exactly one JSON value with no unknown fields.
func strictDecode(content []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("it must hold one JSON object of settings")
	}
	return nil
}

func applyEnvironment(lookup func(string) (string, bool), cfg *Config) error {
	text := func(variable string, target *string) {
		if value, ok := lookup(variable); ok {
			*target = value
		}
	}
	text("APP_ENVIRONMENT", &cfg.Environment)
	text("APP_HOST", &cfg.Host)
	text("APP_DATABASE_URL", &cfg.DatabaseURL)
	text("APP_LOG_LEVEL", &cfg.LogLevel)
	if value, ok := lookup("APP_PORT"); ok {
		port, err := strconv.Atoi(value)
		if err != nil {
			return fmt.Errorf("port from APP_PORT must be a whole number from 1 to 65535")
		}
		cfg.Port = port
	}
	if value, ok := lookup("APP_DATABASE_TIMEOUT_SECONDS"); ok {
		seconds, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return fmt.Errorf("database_timeout_seconds from APP_DATABASE_TIMEOUT_SECONDS must be a number of seconds from %g to %g",
				MinDatabaseTimeoutSeconds, MaxDatabaseTimeoutSeconds)
		}
		cfg.DatabaseTimeoutSeconds = seconds
	}
	if value, ok := lookup("APP_DOCS_ENABLED"); ok {
		switch value {
		case "true", "false":
			cfg.DocsEnabled = value == "true"
		default:
			return fmt.Errorf("docs_enabled from APP_DOCS_ENABLED must be true or false")
		}
	}
	return nil
}

func validate(cfg Config) error {
	switch {
	case cfg.Environment == "":
		return errors.New("environment must be a non-empty string")
	case cfg.Host == "":
		return errors.New("host must be a non-empty string")
	case cfg.Port < 1 || cfg.Port > 65535:
		return errors.New("port must be a whole number from 1 to 65535")
	case cfg.DatabaseURL == "":
		return errors.New("database_url must be a non-empty string")
	// The range also keeps the timeout a usable, representable time.Duration.
	case !(cfg.DatabaseTimeoutSeconds >= MinDatabaseTimeoutSeconds && cfg.DatabaseTimeoutSeconds <= MaxDatabaseTimeoutSeconds):
		return fmt.Errorf("database_timeout_seconds must be a number of seconds from %g to %g",
			MinDatabaseTimeoutSeconds, MaxDatabaseTimeoutSeconds)
	case !slices.Contains(LogLevels, cfg.LogLevel):
		return fmt.Errorf("log_level must be one of %v", LogLevels)
	}
	return nil
}
