import { execSync, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import https from 'https';
import tar from 'tar';
import { IncomingMessage } from 'http';
import { CacheClient } from '@backstage/backend-common';
import { getLogger } from '../service/utils';

export interface GenDocConfig {
  enabled?: boolean;
  useCache?: {
    enabled: boolean;
    ttlInMinutes: number;
  };
  protocGenDoc?: {
    install?: boolean;
    version?: string;
  };
}

export interface GenDocConfigWithCache extends GenDocConfig {
  cacheClient?: CacheClient;
}

let isInstalled: boolean = false;
const PROTOC_DOC_BIN_NAME = 'protoc-gen-doc';

// Mapping from Node's `process.arch` to Golang's `$GOARCH`
const ARCH_MAPPING: Record<string, string> = {
  x64: 'amd64',
};

// Mapping between Node's `process.platform` to Golang's
const PLATFORM_MAPPING: Record<string, string> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};

const protocGenDocBasePath = `https://github.com/pseudomuto/${PROTOC_DOC_BIN_NAME}/releases/download`;

const arch = ARCH_MAPPING[process.arch];
const platform = PLATFORM_MAPPING[process.platform];

const binDirPath = path.resolve(process.cwd(), './bin');

export function isInstalledProtocGenDoc() {
  const logger = getLogger();
  logger.info('Checking if protoc is installed');
  if (isInstalled) return isInstalled;

  // yarn protoc will trigger @protobuf-ts/protoc binary and install protoc if needed
  spawnSync('yarn protoc --help');
  const protocFilePath = execSync('which protoc').toString();

  // protoc-gen-doc should be in the same directory as protoc
  const protocDirPath = path.dirname(protocFilePath);
  let symlinkFilePath = path.resolve(protocDirPath, `./${PROTOC_DOC_BIN_NAME}`);

  if (platform === 'windows') {
    symlinkFilePath += '.exe';
  }

  try {
    if (fs.lstatSync(symlinkFilePath).isSymbolicLink()) {
      // Already installed
      isInstalled = true;
    }
  } catch (err) {
    // Ignore
  }

  return isInstalled;
}

function installProtocGenDoc(res: IncomingMessage) {
  const logger = getLogger();
  logger.info('Installing protoc-gen-doc');
  let binFilePath = path.resolve(binDirPath, `./${PROTOC_DOC_BIN_NAME}`);
  spawnSync('yarn protoc --help');
  const protocFilePath = execSync('which protoc').toString();
  const protocDirPath = path.dirname(protocFilePath);
  let symlinkFilePath = path.resolve(protocDirPath, `./${PROTOC_DOC_BIN_NAME}`);

  if (platform === 'windows') {
    binFilePath += '.exe';
    symlinkFilePath += '.exe';
  }

  res.pipe(tar.x({ strip: 1, cwd: binDirPath }));
  fs.symlinkSync(binFilePath, symlinkFilePath);
  isInstalled = true;
}

async function downloadFile(url: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    https.get(url, (res) => {
      const { statusCode, headers } = res;
      const { location } = headers;

      if (statusCode! > 300 && statusCode! < 400 && location) {
        https.get(location, resolve).on('error', reject);
      } else if (statusCode === 404) {
        reject(new Error(`404 ${url} download failed`));
      } else {
        resolve(res);
      }
    }).on('error', reject);
  })
}

export async function installDocGenerator(protocGenDocVersion: string) {
  // Download from github
  const protocGenDocTarFile = `${PROTOC_DOC_BIN_NAME}_${protocGenDocVersion}_${platform}_${arch}.tar.gz`;
  const protocGenDocTarPath = `v${protocGenDocVersion}/${protocGenDocTarFile}`;
  const protocGenDocUrl = `${protocGenDocBasePath}/${protocGenDocTarPath}`;

  const res = await downloadFile(protocGenDocUrl);
  installProtocGenDoc(res);
}

export async function genDoc(protoPath: string, imports?: string[], genDocConfig?: GenDocConfig) {
  const protoDir = path.dirname(protoPath);
  const protoName = path.basename(protoPath, '.proto');
  const docPath = `${protoName}.md`;
  const docFullPath = path.join(protoDir, docPath);
  let cacheClient: CacheClient | undefined;

  if (genDocConfig?.useCache?.enabled) {
    cacheClient = (genDocConfig as GenDocConfigWithCache).cacheClient;
    const lastTime = await cacheClient?.get?.(docFullPath) as string;
    if (lastTime) {
      return lastTime;
    }
  }

  let command = `cd ${protoDir} \
      && yarn protoc --doc_out=${protoDir} --doc_opt=markdown,${docPath}`;

  if (imports) {
    imports.forEach((dir) => {
      command += ` --proto_path=${dir}`;
    });
  }

  command += ` ${protoName}.proto`;

  execSync(command);

  const doc = fs.readFileSync(path.join(protoDir, docPath), 'utf8');

  if (genDocConfig?.useCache?.enabled) {
    await cacheClient!.set(docFullPath, doc, {
      ttl: genDocConfig.useCache.ttlInMinutes * 60000,
    });
  }
  return doc;
}
