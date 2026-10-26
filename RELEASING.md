# Releasing

## First release (the package does not exist on npm yet)

npm can attach a trusted publisher only to a package that exists, so the first version is published by hand, by the owner, with two-factor authentication:

```sh
git clone https://github.com/mirko-pira/fastify-lazy-schema && cd fastify-lazy-schema
npm ci                        # the typecheck, tests and build below need the dev dependencies
npm login
npm publish --access public   # runs typecheck, tests and the build first; asks for the 2FA code
```

Then, on npmjs.com, open the package → Settings → Trusted publishing → GitHub Actions, and set: user `mirko-pira`, repository `fastify-lazy-schema`, workflow `release.yml`, environment `npm`, with permission to publish directly. Finally push the tag, which records the release (the workflow skips a version already on npm):

```sh
git tag v0.1.0 && git push origin v0.1.0
```

## Later releases

1. Update `version` in `package.json` and the entry in `CHANGELOG.md`, merged into `main` with CI green.
2. Push a tag `v<version>` matching `package.json`.
3. `.github/workflows/release.yml` checks the tag, runs typecheck, tests and the consumer smoke test, and publishes through npm trusted publishing with provenance. No npm token is stored anywhere.
