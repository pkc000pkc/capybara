# Capybara website

The official Capybara website and future home of the project blog and public documentation.

The site includes the homepage, engineering blog, and public roadmap. The roadmap separates available developer tools, active research and prototypes, next product priorities, and exploratory directions. It is not a dated release commitment.

## Pages

- `/` — homepage, with an introduction to the next product direction.
- `/blog/` — engineering notes and research.
- `/roadmap/` — current direction and status, reviewed on 2026-10-20.

Navigation and assets use Astro's configured base URL, including the `/capybara/` prefix for GitHub project Pages builds. The existing GitHub Pages workflow is unchanged.

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
npm run check
npm run build
```

Run these commands from `apps/website`. Use `npm run preview` to inspect the static build locally. Local edits do not publish the site; publication still requires a separate commit, push, and deployment.
