# Sites adapter source

These are generic route/UI adapters for the existing private Sites deployment. Copy their relative paths into a Sites Vinext starter alongside the sibling `bridge/` contracts. Retain the starter’s platform-owned authentication helpers; do not implement native auth or fabricate identity headers. Enable the existing MCP capability and D1 binding through the supported Sites workflow. No runtime IDs or auth state belong in public source.

The public CI job type-checks the dependency-free contracts and tests. The full private Site is separately type-checked, linted and built with its starter dependencies; the adapters are not a standalone self-hosted app.
