import path from 'path';
import fs from 'fs';
import { partial, uniq } from 'lodash';
import { Service } from 'protobufjs';

import { fromFileName, mockRequestMethods, Proto, walkServices } from './bloomrpc-mock';
import { BaseFile, EntitySpec, FileWithImports, WritableFile } from './types';
import { ProtoFile, ProtoService } from './protobuf';
import { CustomPlaceholderProcessor } from './placeholderProcessor';
import { NotImplementedError } from './error';
import { getAllPossibleSubPaths, LoadProtoStatus, getRelativePath, getAbsolutePath, getFileNameFromPath } from '../service/utils';

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

export function saveProtoTextAsFile(basePath: string, file: WritableFile): BaseFile {
  const filePath = path.resolve(basePath, file.filePath);

  if (!fs.existsSync(filePath)) {
    ensureDirectoryExistence(filePath);
    fs.writeFileSync(filePath, file.content, 'utf-8');
  }

  return {
    fileName: file.fileName,
    filePath: file.filePath,
  };
}

export async function getProtosFromEntitySpec(basePath: string, entitySpec: EntitySpec, placeholderProcessor: CustomPlaceholderProcessor) {
  try {
    const { files: files, imports } = await placeholderProcessor.processEntitySpec(entitySpec);

    const pSaveProtoTextAsFile = partial(saveProtoTextAsFile, basePath);

    return {
      files: files.map(pSaveProtoTextAsFile),
      imports: imports.map(pSaveProtoTextAsFile),
    }
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
 * @param filePaths
 * @param importPaths
 */
export async function loadProtos(basePath: string, protoFiles: FileWithImports[]): Promise<LoadProtoResult> {
  // const protoFileFromFiles = await loadProtosFromFile(basePath, protoPaths, importPaths);
  const protoFileFromFiles = await loadProtosFromFile(basePath, protoFiles);
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
export async function loadProtoFromReflection(_host: string): Promise<ProtoFile[]> {
  throw new NotImplementedError();
}

/**
 * Load protocol buffer files from proto files
 * @param filePaths
 * @param importPaths
 */
export async function loadProtosFromFile(basePath: string, protoFiles: FileWithImports[]): Promise<LoadProtoResult> {
  const result: LoadProtoResult = {
    protos: [],
    missingImports: [],
    status: LoadProtoStatus.ok,
  };

  const pGetAbsolutePath = partial(getAbsolutePath, basePath);
  const pGetRelativePath = partial(getRelativePath, basePath);

  const protos: Proto[] = [];

  for (const protoFile of protoFiles) {
    const { filePath, importPaths } = protoFile;
    const absoluteFilePath = pGetAbsolutePath(filePath);
    const absoluteImportPaths = (importPaths || []).map(pGetAbsolutePath)

    try {
      const allImports = getAllPossibleSubPaths(
        basePath,
        absoluteFilePath,
        ...absoluteImportPaths,
      );

      const proto = await fromFileName(absoluteFilePath, allImports);

      // Hide full filepath
      proto.filePath = pGetRelativePath(proto.filePath);
      const relativeImports = uniq((importPaths || []).map(pGetRelativePath));
      proto.importPaths = relativeImports;
      protos.push(proto);
    } catch (err) {
      console.log('OUTPUT ~ loadProtosFromFile ~ err', err);
      if (err.errno === -2) {
        const missingImports: string[] = []

        if (err.path) {
          missingImports.push(path.relative(path.dirname(absoluteFilePath), pGetAbsolutePath(err.path)));
        }

        result.missingImports?.push({
          filePath: pGetRelativePath(filePath),
          fileName: getFileNameFromPath(filePath),
          importPaths: missingImports,
        });

        result.status = LoadProtoStatus.part;
      } else {
        result.status = LoadProtoStatus.fail;
      }
    }
  }

  const protoList = protos.reduce((list: ProtoFile[], proto: Proto) => {
    // Services with methods
    const services = parseServices(proto);

    // Proto file
    list.push({
      proto,
      fileName: proto.fileName.split(path.sep).pop() || "",
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

