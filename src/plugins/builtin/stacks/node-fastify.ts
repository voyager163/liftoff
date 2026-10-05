import { builtinDescriptor, projectArtifact } from '../core.js';

/** Node.js/Fastify/TypeScript serves standard APIs only; every identity is unconditional. */
export const nodeFastifyPlugin = builtinDescriptor({
  category: 'stack',
  id: 'node-fastify',
  contentVersion: 2,
  supports: [{ workload: ['standard'] }],
  artifacts: ([
    ['node-backend-package', 'backend', ['backend', 'package.json']],
    ['node-backend-lock', 'backend', ['backend', 'package-lock.json']],
    ['node-backend-tsconfig', 'backend', ['backend', 'tsconfig.json']],
    ['node-backend-drizzle-config', 'backend', ['backend', 'drizzle.config.ts']],
    ['node-backend-config', 'backend', ['backend', 'src', 'config.ts']],
    ['node-backend-app', 'backend', ['backend', 'src', 'app.ts']],
    ['node-backend-server', 'backend', ['backend', 'src', 'server.ts']],
    ['node-backend-database', 'backend', ['backend', 'src', 'database.ts']],
    ['node-backend-schema', 'backend', ['backend', 'src', 'db', 'schema.ts']],
    ['node-backend-test-health', 'backend-test', ['backend', 'test', 'health.test.ts']],
    ['node-backend-vitest-config', 'backend-test', ['backend', 'vitest.config.ts']],
    ['database-node-migration', 'database', ['database', 'migrations', '0000_initial.sql']],
    ['database-node-migration-journal', 'database', ['database', 'migrations', 'meta', '_journal.json']],
    ['database-node-migration-snapshot', 'database', ['database', 'migrations', 'meta', '0000_snapshot.json']],
    ['database-schema', 'database', ['database', 'models', 'schema.sql']]
  ] as const).map(([logicalName, category, pathParts]) => projectArtifact(logicalName, category, pathParts))
});
