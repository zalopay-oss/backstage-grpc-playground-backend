import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import https from 'https';
import tar from 'tar';
import { IncomingMessage } from 'http';
import { CacheClient } from '@backstage/backend-common';
import { getLogger, REPO_URL } from '../service/utils';
import os from 'os';

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

let protocFilePath: string | undefined;
const protocInstallDirectory = path.join(process.cwd(), "@protobuf-ts", "protoc", "installed");

const protocGenDocBasePath = `https://github.com/pseudomuto/${PROTOC_DOC_BIN_NAME}/releases/download`;

const arch = ARCH_MAPPING[process.arch];
const platform = PLATFORM_MAPPING[process.platform];

const binDirPath = path.resolve(process.cwd(), './.bin');

const findProtocInPath = (envPath: string) => {
  if (typeof envPath !== "string") {
    return undefined;
  }
  const candidates = envPath.split(path.delimiter)
    .filter(p => !p.endsWith(`node_modules${path.sep}.bin`)) // make sure to exlude ...
    .filter(p => !p.endsWith(`.npm-global${path.sep}bin`)) // ...
    .map(p => path.join(p, os.platform() === "win32" ? "protoc.exe" : "protoc")) // we are looking for "protoc"
    .map(p => p[0] === "~" ? path.join(os.homedir(), p.slice(1)) : p); // try expand "~"

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  return undefined;
};

export function isInstalledProtocGenDoc() {
  const logger = getLogger();
  logger.info('Checking if protoc is installed');
  if (isInstalled) return isInstalled;

  const { path: pProtocFilePath, isSymbolicLink } = getProtocPath();

  if (pProtocFilePath) {
    // protoc-gen-doc should be in the same directory as protoc
    const protocDirPath = path.dirname(pProtocFilePath);
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

    if (isSymbolicLink) {
      // If protoc is not found in $PATH, we add it to
      try {
        execSync(`export PATH=$PATH:${pProtocFilePath}`);
        logger.info('which protoc', execSync('which protoc').toString());
      } catch (err) {
        logger.error(`Can not export protoc path to $PATH env. Please submit a new issue at ${REPO_URL}`);
      }
    }
  }

  return isInstalled;
}

function getProtocPath() {
  let isSymbolicLink = false;
  const logger = getLogger();

  if (!protocFilePath) {
    // Try read with which protoc
    try {
      protocFilePath = execSync('which protoc').toString();
    } catch (err) {
      logger.error('Can not find protoc with command $which protoc');
    }
  }

  if (!protocFilePath) {
    // Look in @protobuf-ts/protoc
    for (const name of fs.readdirSync(protocInstallDirectory)) {
      const abs = path.join(protocInstallDirectory, name);

      if (!fs.lstatSync(abs).isDirectory()) {
        continue;
      }

      // looking for directory names "protoc-$VERSION"
      if (!name.startsWith("protoc-")) {
        continue;
      }

      let protocPath = path.join(abs, "bin/protoc.exe");
      if (!fs.existsSync(protocPath)) {
        protocPath = path.join(abs, "bin/protoc");
      }

      protocFilePath = protocPath;
      isSymbolicLink = true;
      break;
    }
  }

  if (!protocFilePath) {
    logger.error(`Protoc is not installed. Please submit a new issue at ${REPO_URL}`);
  } else {
    logger.info(`Protoc is located at ${protocFilePath}, now we export path`);
  }

  return {
    path: protocFilePath,
    isSymbolicLink,
  };
}

function installProtocGenDoc(res: IncomingMessage) {
  const logger = getLogger();
  logger.info('Installing protoc-gen-doc');
  let binFilePath = path.resolve(binDirPath, `./${PROTOC_DOC_BIN_NAME}`);
  // spawnSync('yarn protoc --help');
  execSync('yarn protoc --help');
  const { path: _protocFilePath } = getProtocPath();

  if (!_protocFilePath) {
    logger.error('Can not install protoc-gen-doc because protoc is not found');
    return
  };

  const protocDirPath = path.dirname(_protocFilePath);
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
    await cacheClient?.set(docFullPath, doc, {
      ttl: genDocConfig.useCache.ttlInMinutes * 60000,
    });
  }
  return doc;
}
