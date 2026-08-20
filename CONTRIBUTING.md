# Contributing

Contributions are welcome! Please open an issue or pull request on GitHub.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run linter
npm run lint
```

## Adding a new free model

If OpenCode Zen adds a new free model, update `DEFAULT_MODELS` in `lib/index.js`
and the table in `README.md`, then bump the minor version in `package.json`.
