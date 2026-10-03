import { builtinDescriptor, projectArtifact } from '../core.js';

/** Go/Huma/Chi serves standard APIs only; every identity is unconditional. */
export const goHumaPlugin = builtinDescriptor({
  category: 'stack',
  id: 'go-huma',
  contentVersion: 1,
  supports: [{ workload: ['standard'] }],
  artifacts: ([
    ['go-backend-module', 'backend', ['backend', 'go.mod']],
    ['go-backend-checksums', 'backend', ['backend', 'go.sum']],
    ['go-backend-makefile', 'backend', ['backend', 'Makefile']],
    ['go-backend-main', 'backend', ['backend', 'cmd', 'api', 'main.go']],
    ['go-backend-migration-command', 'backend', ['backend', 'cmd', 'migrate', 'main.go']],
    ['go-backend-api', 'backend', ['backend', 'internal', 'api', 'api.go']],
    ['go-backend-config', 'backend', ['backend', 'internal', 'config', 'config.go']],
    ['go-runtime-config-example', 'configuration', ['runtime.config.example.json']],
    ['go-backend-database', 'backend', ['backend', 'internal', 'database', 'database.go']],
    ['go-backend-test-health', 'backend-test', ['backend', 'internal', 'api', 'api_test.go']],
    ['database-go-migration', 'database', ['database', 'migrations', '0001_initial.sql']],
    ['database-schema', 'database', ['database', 'models', 'schema.sql']]
  ] as const).map(([logicalName, category, pathParts]) => projectArtifact(logicalName, category, pathParts))
});
