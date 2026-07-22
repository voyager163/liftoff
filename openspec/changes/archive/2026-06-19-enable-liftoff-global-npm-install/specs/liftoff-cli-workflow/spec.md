## MODIFIED Requirements

### Requirement: Liftoff exposes a Node-based CLI
The system SHALL provide a Node.js command-line interface named `liftoff` that is installable from the published `@msn-control/liftoff` npm package without requiring Python to run the generator.

#### Scenario: Run create command
- **WHEN** a developer runs `liftoff create`
- **THEN** the system starts the project creation flow without requiring Python to run the generator

#### Scenario: Run non-interactive create command
- **WHEN** a developer runs `liftoff create my-app --pattern rag --cloud azure --region eastus --spec openspec --no-frontend --yes`
- **THEN** the system resolves the provided options into a project plan without prompting for framework, API framework, infrastructure tool, database, cache, observability, or developer portal choices

#### Scenario: Run CLI after global npm install
- **WHEN** a developer installs Liftoff with `npm install -g @msn-control/liftoff@latest`
- **THEN** the `liftoff` command is available from the developer's shell
- **AND** running `liftoff help` displays the Liftoff command help