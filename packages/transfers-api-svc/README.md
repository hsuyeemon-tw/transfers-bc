# Transfers Bounded Context - Transfers Service

### Install

See notes in root dir of this repository
More information on how to install NVM: https://github.com/nvm-sh/nvm

## Build

```bash
npm run build
```

## Run this service

Anywhere in the repo structure:

```bash
npm run packages/event-handler-svc start
```

## Auto build (watch)

```bash
npm run watch
```

## Unit Tests

```bash
npm run test:unit
```

## Integration Tests

```bash
npm run test:integration
```

## Docker image build

Notes:
- run at the root of the monorepo
- update the version tag at the end (0.1.0) to match the version on package.json
```bash
docker build -f packages/transfers-api-svc/Dockerfile -t mojaloop/transfers-bc-transfers-api-svc:0.1.0 .
```

