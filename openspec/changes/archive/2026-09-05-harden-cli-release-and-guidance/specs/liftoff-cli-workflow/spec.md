## ADDED Requirements

### Requirement: Infrastructure recipes use the selected project's actual context
Inside a known API project, infrastructure helpers SHALL render the generated
OpenTofu module directory and an environment declared by that project. If no
environment override is provided, they SHALL use the first selected environment.
They SHALL remain printed-only and SHALL resolve paths portably on Windows,
macOS, and Linux.

#### Scenario: Project selects only production
- **WHEN** the project declares only `prod` and the developer requests an infrastructure plan recipe
- **THEN** the recipe targets the generated module and `prod.tfvars`
- **AND** it does not reference nonexistent `dev.tfvars`

#### Scenario: Requested environment is absent
- **WHEN** a helper requests an environment not declared by the project
- **THEN** it reports the unsupported project environment instead of printing an unusable recipe

#### Scenario: Project path contains spaces
- **WHEN** a helper resolves the generated module from a project path containing spaces on a supported host
- **THEN** the printed command preserves that path as one argument
- **AND** no infrastructure command is executed

### Requirement: Dependency-failure output states the real preservation boundary
Dependency setup failure output SHALL distinguish protected package/lock
metadata from other project files that dependency lifecycle scripts may have
modified. It SHALL NOT claim the entire scaffold was preserved unless that
guarantee was actually enforced.

#### Scenario: Installation fails after running scripts
- **WHEN** a dependency command fails and protected metadata is restored
- **THEN** the output states which metadata was protected or restored
- **AND** tells the developer that other file changes may require review
