# Capybara website

The official Capybara website and future home of the project blog and public documentation.

The first homepage presents Capybara's context-focused product direction. Blog, documentation, and other routes are intentionally deferred.

## Development

From the website directory:

```bash
cd apps/website
npm install
npm run dev
```

The local site runs at `http://localhost:4321/` by default.

## Validation

```bash
npm run typecheck --workspace=apps/website
npm run build --workspace=apps/website
```
