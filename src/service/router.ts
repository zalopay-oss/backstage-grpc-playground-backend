import { errorHandler, UrlReader } from '@backstage/backend-common';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import {
  PlaceholderResolver,
} from '@backstage/plugin-catalog-backend';
import { uniqBy } from 'lodash';
import { ScmIntegrationRegistry } from '@backstage/integration';

import {
  ProtoService, ProtoInfo, GRPCRequest, GRPCEventType, ResponseMetaInformation,
  RawPlaceholderFile, PlaceholderFile, FileWithImports, BaseFile,
  RawEntitySpec, EntitySpec, GRPCTarget, LoadProtoResult,
  loadProtos, getProtosFromEntitySpec, ensureDirectoryExistence,
  textPlaceholderResolver, CustomPlaceholderProcessor,
} from './../api';

import {
  LoadProtoStatus, getProtoInput,
  sendRequestInput, getProtoUploadPath,
  validateRequestBody, getAbsolutePath, getFileNameFromPath,
} from './utils';

export interface RouterOptions {
  logger: Logger;
  reader: UrlReader;
  integrations: ScmIntegrationRegistry;
}

const getTime = () => new Date().toLocaleTimeString();

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const {
    logger,
    reader,
    integrations,
  } = options;

  const router = Router();
  router.use(express.json());

  const placeholderResolvers: Record<string, PlaceholderResolver> = {
    text: textPlaceholderResolver,
  };

  const placeholderProcessor = new CustomPlaceholderProcessor({
    resolvers: placeholderResolvers,
    reader,
    integrations,
  });

  router.get('/health', (_, response) => {
    logger.info('PONG!');
    response.send({ status: 'ok' });
  });

  router.post('/proto-info/:entity', async (req, res) => {
    const { entitySpec: rawSpec } = await validateRequestBody(req, getProtoInput);
    const result: LoadProtoResult = {
      protos: [],
      missingImports: [],
      status: LoadProtoStatus.ok,
    }

    const { entity: entityName } = req.params;
    const UPLOAD_PATH = getProtoUploadPath(entityName);

    const { entitySpec, preloadedProtos } = mapRawEntitySpec(rawSpec as RawEntitySpec);

    // Stage 1: Load from local storage
    if (preloadedProtos?.length) {
      const {
        protos,
        status,
        missingImports
      } = await loadProtos(UPLOAD_PATH, preloadedProtos);

      result.protos.push(...protos);

      result.protos.forEach((preloaded) => {
        const index = entitySpec.files.findIndex(p => p.filePath === preloaded.proto.filePath);
        if (index > -1) {
          // preloaded, no need to get again in stage 2
          entitySpec.files.splice(index, 1);
        }
      });

      if (status !== undefined) {
        result.status = status;
      }

      if (missingImports?.length) {
        result.missingImports?.push(...missingImports);
      }
    }

    // Stage 2: handle with placeholder
    if (entitySpec?.files.length) {
      const getProtoData = await getProtosFromEntitySpec(UPLOAD_PATH, entitySpec, placeholderProcessor);

      if (getProtoData) {
        const { files: protoFiles, imports } = getProtoData;

        const filesToLoad: FileWithImports[] = protoFiles.map(f => ({
          ...f,
          importPaths: imports.map(imp => imp.filePath),
        }))

        const {
          protos: files,
          missingImports,
          status,
        } = await loadProtos(UPLOAD_PATH, filesToLoad);

        // Unify result from two stages
        if (status !== undefined) {
          if (status === LoadProtoStatus.ok) {
            if (result.status === LoadProtoStatus.part) {
              // we filter out missing that has been resolved in stage 2
              result.missingImports = result.missingImports?.filter(missing => {
                return !result.protos.find(protoFile => protoFile.proto.filePath === missing.filePath);
              })

              if (!result.missingImports?.length) {
                // All missing has been resolved on stage 2, we set to ok
                result.status = LoadProtoStatus.ok;
              }
            }
          } else {
            // Load with stage 2 is more important
            result.status = status; // part or fail

            // Add missing to the final result
            if (missingImports?.length) {
              result.missingImports!.push(...missingImports);
            }
          }

          result.protos.push(...files);
        }
      }
    }

    result.missingImports = uniqBy(result.missingImports!, 'filePath');

    res.send(result);
  });

  router.post('/upload-proto/:entity', async (req, res) => {
    const { entity: entityName } = req.params;
    const UPLOAD_PATH = getProtoUploadPath(entityName);

    const storage = multer.diskStorage({
      destination: function (_req, _file, callback) {
        if (!fs.existsSync(UPLOAD_PATH)) {
          fs.mkdirSync(UPLOAD_PATH, {
            recursive: true
          });
        }

        callback(null, UPLOAD_PATH);
      },

      filename: function (_req, file, callback) {
        const fileName = file.originalname;

        // handle duplication
        // if (fs.existsSync(resolveRelativePath(file.originalname))) {
        //   const { ext, name } = path.parse(file.originalname);
        //   fileName = `${name}-${timestamp()}${ext}`;
        // }

        callback(null, fileName);
      }
    });

    const upload = multer({ storage });

    upload.array('files[]', 10)(req, res, async () => {
      if (req.files?.length) {
        let filesWithImports: FileWithImports[] = [];

        const files = req.files as Express.Multer.File[];

        files.forEach((file) => {
          if (req.body.fileMappings) {
            let fileMappings;

            try {
              fileMappings = JSON.parse(req.body.fileMappings);

              if (fileMappings[file.filename]) {
                const newFilePath = getAbsolutePath(UPLOAD_PATH, fileMappings[file.filename]);
                ensureDirectoryExistence(newFilePath);
                fs.renameSync(file.path, newFilePath);

                filesWithImports.push({
                  fileName: file.filename,
                  filePath: newFilePath,
                });

                return;
              }

            } catch (err) {
              console.log('OUTPUT ~ setup storage ~ err', err);
            }
          }

          filesWithImports.push({
            fileName: file.filename,
            filePath: file.path,
          });
        });

        let importFor: BaseFile;

        if (req.body.importFor) {
          try {
            // uplaod files are the imports
            importFor = JSON.parse(req.body.importFor);
            filesWithImports = [{ ...importFor, importPaths: filesWithImports.map(f => f.filePath) }];
          } catch (err) {
            // Invalid import for
            res.send({
              status: LoadProtoStatus.fail,
              message: "Invalid imports"
            });
          }
        }

        const loadProtoResult = await loadProtos(UPLOAD_PATH, filesWithImports);
        res.send(loadProtoResult);
        return;
      }

      res.send({
        status: LoadProtoStatus.fail,
        message: 'Empty files',
      });
    })
  })

  router.post('/send-request/:entity', async (req, res) => {
    const clientRequest = await validateRequestBody(req, sendRequestInput);
    const { entity: entityName } = req.params;

    const UPLOAD_PATH = getProtoUploadPath(entityName);

    const {
      proto: protoPath,
      methodName,
      importPaths,
      serviceName,
      url,
      requestData,
      interactive
    } = clientRequest;

    const filesWithImports = [{
      fileName: getFileNameFromPath(protoPath),
      filePath: protoPath,
      importPaths
    }]

    const { protos: protofiles } = await loadProtos(UPLOAD_PATH, filesWithImports);

    const services = protofiles[0].services;

    const service: ProtoService = services[serviceName];
    const protoInfo = new ProtoInfo(service, methodName);

    const grpcRequest = new GRPCRequest({
      url,
      requestData,
      protoInfo,
      interactive,
    });

    const isStreaming = grpcRequest.isServerStreaming || grpcRequest.isClientStreaming;

    function onError(e: any, metaInfo: ResponseMetaInformation) {
      res.write(JSON.stringify({
        error: e,
        metaInfo,
      }))
    }

    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      })

    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json'
      })
    }

    function onEnd() {
      console.log('ended');
      res.end();
    }

    function onData(data: object, metaInfo: ResponseMetaInformation) {
      const chunk = JSON.stringify({
        data,
        metaInfo
      });

      console.log('OUTPUT ~ onData ~ chunk', chunk);

      if (isStreaming) {
        res.write(`id: ${uuid()}\n`);
        res.write('type: data\n');
        res.write('event: message\n');
        res.write(`time: ${getTime()}\n`);
        res.write(`data: ${chunk}\n\n`)
      } else {
        res.write(chunk);
      }
    }

    grpcRequest
      .on(GRPCEventType.DATA, onData)
      .on(GRPCEventType.ERROR, onError)
      .on(GRPCEventType.END, onEnd)
      .send();

    req.once('close', () => {
      console.log('request closed');
      grpcRequest.cancel();
    })
  });

  router.use(errorHandler());
  return router;
}

const mapRawPlaceholderFile = ({
  file_name, is_library, file_path,
  url, import_paths, is_preloaded
}: RawPlaceholderFile): PlaceholderFile => ({
  fileName: file_name,
  filePath: file_path,
  isPreloaded: is_preloaded,
  isLibrary: is_library,
  importPaths: import_paths,
  url
});

function mapRawEntitySpec(rawSpec: RawEntitySpec) {
  const rawDefinition = rawSpec.files;

  let toGet: PlaceholderFile[] = [];
  let preloadedProtos: FileWithImports[] = [];

  [rawDefinition].flat().forEach(d => {
    if (d.url) {
      toGet.push(mapRawPlaceholderFile(d));
    }

    if (d.is_preloaded) {
      preloadedProtos.push({
        filePath: d.file_path,
        fileName: d.file_name,
        importPaths: d.import_paths,
      });
    }
  })

  toGet = uniqBy(toGet, 'filePath')
  preloadedProtos = uniqBy(preloadedProtos, 'filePath');

  const entitySpec: EntitySpec = {
    files: toGet,
    imports: (rawSpec.imports || []).map(mapRawPlaceholderFile),
    targets: rawSpec.targets as GRPCTarget
  }

  return {
    entitySpec,
    preloadedProtos,
  }
}
