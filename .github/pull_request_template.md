## Summary

<!-- What changes and why. Link the issue if there is one. -->

## Test plan

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run e2e:sandbox` (real Rex; when the change touches Rex, setup, sharing or the bridge)
- [ ] `npm run docs:commands` if `src/cli/help.ts` changed
- [ ] CHANGELOG entry and version bump, if this is a release

## Checklist

- [ ] No tokens, webhook URLs or keys, real hostnames, tailnet names, emails or home paths in code, tests, docs or this PR
- [ ] Docs updated (README, `docs/`) where behaviour changed
