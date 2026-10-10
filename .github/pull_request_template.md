<!--
Thanks for contributing. Pull requests are squash-merged, so the title becomes the commit message: use
Conventional Commits (`fix: …`, `feat: …`, `docs: …`). CONTRIBUTING.md has the details.
-->

## What and why

<!-- What does this change, and why? Link the issue it fixes, if there is one. -->

## Checklist

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass.
- [ ] If anything under `src/` changed, I ran `npm run build` and committed `dist/action/index.js`.
- [ ] If `registry/` changed, each value is quoted word for word in its `source_excerpt`, I ran
      `npm run registry:format`, and `npm run registry:validate` passes.
- [ ] New behavior has a test, and user-facing changes update the docs.
