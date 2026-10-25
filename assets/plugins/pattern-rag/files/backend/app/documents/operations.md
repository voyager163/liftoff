# Running the service

The liveness endpoint, /health/live, only says the process is running. The
readiness endpoint, /health/ready, also checks that documents were loaded.

The model is chosen with APP_MODEL. Its provider reads the key from the
environment, so keys never appear in configuration files.
