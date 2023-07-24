# backstage-grpc-playground-backend

![GitHub](https://img.shields.io/github/license/zalopay-oss/backstage-grpc-playground-backend) ![Project Level](https://img.shields.io/badge/level-beta-yellowgreen) ![GitHub issues](https://img.shields.io/github/issues/zalopay-oss/backstage-grpc-playground-backend) ![GitHub contributors](https://img.shields.io/github/contributors-anon/zalopay-oss/backstage-grpc-playground-backend?color=blue) ![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/zalopay-oss/backstage-grpc-playground-backend)

<!-- TOC -->
- [**Overview**](#overview)
- [**Install**](#install)
- [**Usage**](#usage)
- [**Acknowledgements**](#acknowledgements)

## Overview

This repo contains backend code of the [backstage-grpc-playground](https://github.com/zalopay-oss/backstage-grpc-playground.git)

## Install

Install backstage-grpc-playground-backend for `packages/backend`

E.g: In your backstage project root

```zsh
  yarn --cwd packages/backend add backstage-grpc-playground-backend
```

## Usage

#### Register the plugin in backend

Create a new file `packages/backend/src/plugins/grpc-playground.ts`

```typescript
// packages/backend/src/plugins/grpc-playground.ts
import { ScmIntegrations } from '@backstage/integration';
import { createRouter } from 'backstage-grpc-playground-backend';

import { Router } from 'express';
import { PluginEnvironment } from '../types';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  const { config, reader } = env;

  const integrations = ScmIntegrations.fromConfig(config);

  return await createRouter({
    logger: env.logger,
    reader,
    integrations,
    database: env.database,
  });
}
```

#### Register `/grpc-playground` path in backstage backend

```typescript
// packages/backend/src/index.ts
import grpcPlayground from './plugins/grpc-playground';

async function main() {
  // other env
  const grpcPlaygroundEnv = useHotMemoize(module, () => createEnv('grpc-playground'));
  
  // init router
  // ...

  // register before notFoundHandler  
  apiRouter.use('/grpc-playground', await grpcPlayground(grpcPlaygroundEnv));

  // not found handler
  apiRouter.use(notFoundHandler());
}
```

## Examples

See [examples](https://github.com/zalopay-oss/backstage-grpc-playground#examples)

## Acknowledgements

- Thanks to [Backstage Team](https://github.com/backstage/backstage) for creating an incredable framework
- Thanks to the authors of the awesome [BloomRPC Application](https://github.com/bloomrpc/bloomrpc)
- Feel free to [submit new issues](https://github.com/zalopay-oss/backstage-grpc-playground-backend/issues/new)
