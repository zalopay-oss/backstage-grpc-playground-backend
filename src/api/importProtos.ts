import path from 'path';
import fs from 'fs';
import { partial, uniqBy } from 'lodash';
import { Service } from 'protobufjs';

import {
  fromFileName,
  mockRequestMethods,
  Proto,
  walkServices,
} from './bloomrpc-mock';
import {
  EntitySpec,
  FileWithImports,
  PlaceholderFile,
  WritableFile,
} from './types';
import { ProtoFile, ProtoService } from './protobuf';
import { CustomPlaceholderProcessor } from './placeholderProcessor';
import { NotImplementedError } from './error';
import {
  getAllPossibleSubPaths,
  LoadProtoStatus,
  getRelativePath,
  getAbsolutePath,
  getFileNameFromPath,
} from '../service/utils';
import { genDoc, GenDocConfig, installDocGenerator, isInstalledProtoc } from './docGenerator';

export type LoadProtoResult = {
  protos: ProtoFile[];
  missingImports?: FileWithImports[];
  status?: LoadProtoStatus;
};

export function ensureDirectoryExistence(filePath: string) {
  const dirname = path.dirname(filePath);

  if (fs.existsSync(dirname)) {
    return;
  }

  fs.mkdirSync(dirname, {
    recursive: true,
  });
}

export function saveProtoTextAsFile(
  basePath: string,
  file: WritableFile,
): PlaceholderFile {
  const filePath = path.resolve(basePath, file.filePath);

  if (!fs.existsSync(filePath)) {
    ensureDirectoryExistence(filePath);

    if (file.content) {
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
  }

  return {
    fileName: file.fileName,
    filePath: file.filePath,
    url: file.url,
    imports: file.imports?.map(imp => saveProtoTextAsFile(basePath, imp)),
  };
}

export async function getProtosFromEntitySpec(
  basePath: string,
  entitySpec: EntitySpec,
  placeholderProcessor: CustomPlaceholderProcessor,
) {
  try {
    const { files: files, imports } =
      await placeholderProcessor.processEntitySpec(entitySpec);

    const pSaveProtoTextAsFile = partial(saveProtoTextAsFile, basePath);

    return {
      files: files.map(pSaveProtoTextAsFile),
      imports: imports.map(pSaveProtoTextAsFile),
    };
  } catch (err) {
    console.log('OUTPUT ~ getProtosFromEntitySpec ~ err', err);
  }

  return null;
}

/**
 * Upload protofiles from gRPC server reflection
 * @param host
 */
export async function importProtosFromServerReflection(host: string) {
  await loadProtoFromReflection(host);
}

/**
 * Load protocol buffer files
 *
 * // TODO: add ability to loadProtoFromReflection
 * @see https://github.com/bloomrpc/bloomrpc/blob/master/app/behaviour/importProtos.ts#L54
 *
 * @param protoFiles
 */
export async function loadProtos(
  basePath: string,
  protoFiles: FileWithImports[],
  genDocConfig?: GenDocConfig,
): Promise<LoadProtoResult> {
  const protoFileFromFiles = await loadProtosFromFile(basePath, protoFiles, genDocConfig);
  return protoFileFromFiles;
}

/**
 * Load protocol buffer files from gRPC server reflection
 *
 * // TODO: implement
 * @see https://github.com/bloomrpc/bloomrpc/blob/master/app/behaviour/importProtos.ts#L84
 *
 * @param host
 */
export async function loadProtoFromReflection(
  _host: string,
): Promise<ProtoFile[]> {
  throw new NotImplementedError();
}

/**
 * Load protocol buffer files from proto files
 * @param protoFiles
 */
export async function loadProtosFromFile(
  basePath: string,
  protoFiles: FileWithImports[],
  genDocConfig?: GenDocConfig,
): Promise<LoadProtoResult> {
  const result: LoadProtoResult = {
    protos: [],
    missingImports: [],
    status: LoadProtoStatus.ok,
  };

  const pGetAbsolutePath = partial(getAbsolutePath, basePath);
  const pGetRelativePath = partial(getRelativePath, basePath);

  const protos: Proto[] = [];

  // Handle missing imports
  let capturedFromWarning: string | undefined;
  const missingMap = new Map<string, FileWithImports>();

  function handleWarning(warning: Error) {
    const match = warning?.message?.match?.(
      /(.+\.proto) not found in any of the include paths/,
    );
    capturedFromWarning = match?.[1] || '';
  }

  process.on('warning', handleWarning);

  for (const protoFile of protoFiles) {
    const { filePath, imports } = protoFile;
    const absoluteFilePath = pGetAbsolutePath(filePath);
    const absoluteImportPaths = (imports || [])
      .map(p => p.filePath)
      .map(pGetAbsolutePath);

    // Hide full filepath
    const relativeImports = uniqBy(
      (imports || []).map(f => ({
        ...f,
        filePath: pGetRelativePath(f.filePath),
      })),
      'filePath',
    );

    try {
      const allImports = getAllPossibleSubPaths(
        basePath,
        absoluteFilePath,
        ...absoluteImportPaths,
      );
      const proto = await fromFileName(absoluteFilePath, allImports);

      let protoDoc = '';

      if (genDocConfig) {
        const { protocGenDoc, enabled } = genDocConfig;
        const { install, version } = protocGenDoc || {}

        if (enabled) {
          try {
            if (install && version && !isInstalledProtoc()) {
              await installDocGenerator(version);
            }

            protoDoc = genDoc(absoluteFilePath, allImports);
          } catch (err) {
            console.log('OUTPUT ~ genDoc phase ~ err', err);
          }
        }
      }

      proto.protoDoc = protoDoc;
      proto.filePath = pGetRelativePath(proto.filePath);
      proto.imports = relativeImports;
      protos.push(proto);
    } catch (err) {
      console.log('OUTPUT ~ loadProtosFromFile ~ err', err);
      if (err.errno === -2) {
        const missingImports: PlaceholderFile[] = [];
        const capturedMissing = capturedFromWarning || err.path;

        if (capturedMissing) {
          missingImports.push({
            filePath: pGetRelativePath(capturedMissing),
            fileName: getFileNameFromPath(capturedMissing),
          });
        }

        const relativeFilePath = pGetRelativePath(filePath);

        if (!missingMap.has(relativeFilePath)) {
          missingMap.set(relativeFilePath, {
            filePath: relativeFilePath,
            fileName: getFileNameFromPath(filePath),
            missing: missingImports,
            imports: relativeImports,
          });
        } else {
          const current = missingMap.get(relativeFilePath)!;
          const newImports = uniqBy(
            (current.imports || []).concat(relativeImports || []),
            'filePath',
          );

          missingMap.set(relativeFilePath, {
            ...current,
            imports: newImports,
          });
        }

        result.status = LoadProtoStatus.part;
      } else {
        result.status = LoadProtoStatus.fail;
      }
    }

    result.missingImports = Array.from(missingMap.values());
  }

  process.off('warning', handleWarning);

  const protoList = protos.reduce((list: ProtoFile[], proto: Proto) => {
    // Services with methods
    const services = parseServices(proto);

    // Proto file
    list.push({
      proto,
      fileName: proto.fileName.split(path.sep).pop() || '',
      services,
    });

    return list;
  }, []);

  result.protos = protoList;

  return result;
}

/**
 * Parse Grpc services from root
 * @param proto
 */
export function parseServices(proto: Proto) {
  const services: { [key: string]: ProtoService } = {};

  walkServices(proto, (service: Service, _: any, serviceName: string) => {
    const mocks = mockRequestMethods(service);

    services[serviceName] = {
      serviceName: serviceName,
      proto,
      methodsMocks: mocks,
      methodsName: Object.keys(mocks),
      definition: proto.root.lookupService(serviceName),
    };
  });

  return services;
}

/**
 * // TODO: implement
 * @see https://github.com/bloomrpc/bloomrpc/blob/master/app/behaviour/importProtos.ts#L198
 */
export function importResolvePath(): Promise<string | null> {
  throw new NotImplementedError();
}
