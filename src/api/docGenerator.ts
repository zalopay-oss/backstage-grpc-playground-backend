import { execSync, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import https from 'https';
import tar from 'tar';
import { IncomingMessage } from 'http';

export interface GenDocConfig {
  enabled?: boolean;
  protocGenDoc?: {
    install?: boolean;
    version?: string;
  }
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

export function isInstalledProtoc() {
  return isInstalled;
}

const arch = ARCH_MAPPING[process.arch];
const platform = PLATFORM_MAPPING[process.platform];

const binDirPath = path.resolve(process.cwd(), './bin');

function installProtocGenDoc(res: IncomingMessage) {
  console.log('Installing protoc-gen-doc');
  let binFilePath = path.resolve(binDirPath, `./${PROTOC_DOC_BIN_NAME}`);
  spawnSync('yarn protoc --help');
  const protocFilePath = execSync('which protoc').toString();
  const protocDirPath = path.dirname(protocFilePath);
  let symlinkFilePath = path.resolve(protocDirPath, `./${PROTOC_DOC_BIN_NAME}`);

  if (platform === 'windows') {
    binFilePath += '.exe';
    symlinkFilePath += '.exe';
  }

  try {
    if (fs.existsSync(symlinkFilePath)) {
      fs.rmSync(symlinkFilePath);
    }
  } catch (err) {
    console.log('OUTPUT ~ installProtocGenDoc ~ err', err);
    // Ignore
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
  const protocGenDocTarFile = `${PROTOC_DOC_BIN_NAME}_${protocGenDocVersion}_${platform}_${arch}.tar.gz`;
  const protocGenDocTarPath = `v${protocGenDocVersion}/${protocGenDocTarFile}`;
  const protocGenDocUrl = `${protocGenDocBasePath}/${protocGenDocTarPath}`;

  const res = await downloadFile(protocGenDocUrl);
  installProtocGenDoc(res);
}

export function genDoc(protoPath: string, imports?: string[]) {
  const protoDir = path.dirname(protoPath);
  const protoName = path.basename(protoPath, '.proto');
  const docPath = `${protoName}.md`;

  // TODO cache invalidation
  if (fs.existsSync(path.join(protoDir, docPath))) {
    return fs.readFileSync(path.join(protoDir, docPath), 'utf8');
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
  return doc;
}
