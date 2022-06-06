import { errorHandler, UrlReader } from '@backstage/backend-common';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import { PlaceholderResolver } from '@backstage/plugin-catalog-backend';
import { uniqBy } from 'lodash';
import { ScmIntegrationRegistry } from '@backstage/integration';

import {
  ProtoService,
  ProtoInfo,
  GRPCRequest,
  GRPCEventType,
  ResponseMetaInformation,
  PlaceholderFile,
  FileWithImports,
  EntitySpec,
  GRPCTarget,
  LoadProtoResult,
  loadProtos,
  ProtoFile,
  getProtosFromEntitySpec,
  ensureDirectoryExistence,
  textPlaceholderResolver,
  CustomPlaceholderProcessor,
} from './../api';

import {
  LoadProtoStatus,
  getProtoInput,
  sendRequestInput,
  getProtoUploadPath,
  validateRequestBody,
  getAbsolutePath,
  getFileNameFromPath,
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
  const { logger, reader, integrations } = options;

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
    const { entitySpec: fullSpec } = await validateRequestBody(
      req,
      getProtoInput,
    );
    const result: LoadProtoResult = {
      protos: [],
      missingImports: [],
      status: LoadProtoStatus.ok,
    };

    const { entity: entityName } = req.params;
    const UPLOAD_PATH = getProtoUploadPath(entityName);

    const { entitySpec, preloadedProtos } = parseEntitySpec(
      fullSpec as EntitySpec,
    );

    // Stage 1: Load from local storage
    if (preloadedProtos?.length) {
      const { protos, status, missingImports } = await loadProtos(
        UPLOAD_PATH,
        preloadedProtos,
      );

      result.protos.push(...protos);

      result.protos.forEach(preloaded => {
        const index = entitySpec.files.findIndex(
          p => p.filePath === preloaded.proto.filePath,
        );
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
      const getProtoData = await getProtosFromEntitySpec(
        UPLOAD_PATH,
        entitySpec,
        placeholderProcessor,
      );

      if (getProtoData) {
        const { files: protoFiles, imports: commonImports } = getProtoData;

        const filesToLoad: FileWithImports[] = protoFiles.map(f => ({
          ...f,
          imports: commonImports.concat((f.imports || []).flat()),
        }));

        if (result.missingImports?.length) {
          // allFiles are files, their imports and commonImports
          const resolvedFiles = new Map<string, PlaceholderFile>();

          protoFiles
            .concat(commonImports)
            .concat(
              protoFiles.reduce((acc: PlaceholderFile[], file) => {
                return acc.concat(file.imports || []);
              }, []),
            )
            .forEach(f => {
              resolvedFiles.set(f.filePath, f);
            });

          // filter out missing files that are already loaded
          result.missingImports = result.missingImports.filter(missing => {
            return !resolvedFiles.has(missing.filePath);
          });
        }

        const {
          protos: files,
          missingImports,
          status,
        } = await loadProtos(UPLOAD_PATH, filesToLoad);

        // Unify result from two stages
        if (status !== undefined) {
          switch (status) {
            case LoadProtoStatus.ok:
              if (result.status === LoadProtoStatus.part) {
                const resolvedFiles = new Map<string, ProtoFile>();
                files.forEach(f => {
                  resolvedFiles.set(f.proto.filePath, f);
                });

                // we filter out missing that has been resolved in stage 2
                result.missingImports = result.missingImports?.filter(
                  missing => {
                    return !resolvedFiles.has(missing.filePath);
                  },
                );

                if (!result.missingImports?.length) {
                  // All missing has been resolved on stage 2, we set to ok
                  result.status = LoadProtoStatus.ok;
                }
              }
              break;

            case LoadProtoStatus.part:
              // Add missing to the final result
              if (missingImports?.length) {
                result.missingImports = result.missingImports || [];

                // Construct a map of missing files
                const missingMap = new Map<string, PlaceholderFile>();
                result.missingImports.forEach(missing => {
                  missingMap.set(missing.filePath, missing);
                });

                missingImports.forEach(missing => {
                  if (missingMap.has(missing.filePath)) {
                    // if missing file is already in the map, we merge the imports
                    const current = missingMap.get(missing.filePath)!;

                    current.imports = current.imports || [];

                    if (missing.imports?.length) {
                      // construct another map to avoid duplicated imports
                      const importsMap = new Map<string, PlaceholderFile>();
                      current.imports.forEach(imp => {
                        importsMap.set(imp.filePath, imp);
                      });

                      missing.imports.forEach(imp => {
                        if (!importsMap.has(imp.filePath)) {
                          current.imports!.push(imp);
                        }
                      });
                      missingMap.set(missing.filePath, current);
                    }
                  } else {
                    missingMap.set(missing.filePath, missing);
                  }
                });

                result.missingImports = Array.from(missingMap.values());
              }

              result.status = status;
              break;

            default:
              result.status = status;
              break;
          }
        }

        if (files?.length) {
          result.protos.push(...files);
        }
      }
    }

    res.send(result);
  });

  router.post('/upload-proto/:entity', async (req, res) => {
    const { entity: entityName } = req.params;
    const UPLOAD_PATH = getProtoUploadPath(entityName);

    const storage = multer.diskStorage({
      destination: function (_req, _file, callback) {
        if (!fs.existsSync(UPLOAD_PATH)) {
          fs.mkdirSync(UPLOAD_PATH, {
            recursive: true,
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
      },
    });

    const upload = multer({ storage });

    upload.array('files[]', 10)(req, res, async () => {
      if (req.files?.length) {
        let filesWithImports: FileWithImports[] = [];

        const files = req.files as Express.Multer.File[];

        files.forEach(file => {
          if (req.body.fileMappings) {
            let fileMappings;

            try {
              fileMappings = JSON.parse(req.body.fileMappings);

              if (fileMappings[file.filename]) {
                const newFilePath = getAbsolutePath(
                  UPLOAD_PATH,
                  fileMappings[file.filename],
                );
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

        let importFor: PlaceholderFile;

        if (req.body.importFor) {
          try {
            // uplaod files are the imports
            importFor = JSON.parse(req.body.importFor);
            filesWithImports = [
              {
                ...importFor,
                imports: importFor.imports?.concat(filesWithImports),
              },
            ];
          } catch (err) {
            // Invalid import for
            res.send({
              status: LoadProtoStatus.fail,
              message: 'Invalid imports',
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
    });
  });

  router.post('/send-request/:entity', async (req, res) => {
    const clientRequest = await validateRequestBody(req, sendRequestInput);
    const { entity: entityName } = req.params;

    const UPLOAD_PATH = getProtoUploadPath(entityName);

    const {
      proto: protoPath,
      methodName,
      imports,
      serviceName,
      url,
      requestData,
      interactive,
      proxy,
    } = clientRequest;

    const filesWithImports: FileWithImports[] = [
      {
        fileName: getFileNameFromPath(protoPath),
        filePath: protoPath,
        imports,
      },
    ];

    const loadProtoResult = await loadProtos(UPLOAD_PATH, filesWithImports);

    if (loadProtoResult.status !== LoadProtoStatus.ok) {
      res.status(400).json(loadProtoResult);
      return;
    }

    const { protos: protofiles } = loadProtoResult;

    const services = protofiles[0].services;

    const currentHttpProxy: string | undefined = process.env.http_proxy;
    const currentHttpsProxy: string | undefined = process.env.https_proxy;
    const currentGrpcProxy: string | undefined = process.env.grpc_proxy;

    const service: ProtoService = services[serviceName];
    const protoInfo = new ProtoInfo(service, methodName);

    const grpcRequest = new GRPCRequest({
      url,
      requestData,
      protoInfo,
      interactive,
    });

    const isStreaming =
      grpcRequest.isServerStreaming || grpcRequest.isClientStreaming;

    function onError(e: any, metaInfo: ResponseMetaInformation) {
      const chunk = JSON.stringify({
        error: e,
        metaInfo,
      });

      res.write(`id: ${uuid()}\n`);
      res.write('type: data\n');
      res.write('event: message\n');
      res.write(`time: ${getTime()}\n`);
      res.write(`data: ${chunk}\n\n`);
    }

    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
    }

    function onEnd() {
      res.end();

      if (process.env.no_grpc_playground_proxy) {
        // set back proxy
        process.env.http_proxy = currentHttpProxy;
        process.env.https_proxy = currentHttpsProxy;
        process.env.grpc_proxy = currentGrpcProxy;
      }
    }

    function onData(data: object, metaInfo: ResponseMetaInformation) {
      const chunk = JSON.stringify({
        data,
        metaInfo,
      });

      if (isStreaming) {
        res.write(`id: ${uuid()}\n`);
        res.write('type: data\n');
        res.write('event: message\n');
        res.write(`time: ${getTime()}\n`);
        res.write(`data: ${chunk}\n\n`);
      } else {
        res.write(chunk);
      }
    }

    // Workaround for proxy call messing with process.env.http_proxy or process.env.https_proxy
    if (process.env.no_grpc_playground_proxy) {
      delete process.env.http_proxy;
      delete process.env.https_proxy;
      delete process.env.grpc_proxy;
    }

    grpcRequest
      .on(GRPCEventType.DATA, onData)
      .on(GRPCEventType.ERROR, onError)
      .on(GRPCEventType.END, onEnd)
      .send();

    req.once('close', () => {
      console.log('request closed');
      grpcRequest.cancel();
    });
  });

  router.use(errorHandler());
  return router;
}

/**
 * Split files to get into 2 parts: preloaded and toGet
 * @param spec Full entity spec
 * @returns
 */
function parseEntitySpec(spec: EntitySpec) {
  let toGet: PlaceholderFile[] = [];
  let preloadedProtos: FileWithImports[] = [];

  spec.files.forEach(d => {
    if (d.url) {
      toGet.push(d);
    }

    if (d.isPreloaded) {
      preloadedProtos.push(d);
    }
  });

  toGet = uniqBy(toGet, 'filePath');
  preloadedProtos = uniqBy(preloadedProtos, 'filePath');

  const entitySpec: EntitySpec = {
    files: toGet,
    imports: spec.imports || [],
    targets: spec.targets as GRPCTarget,
  };

  return {
    entitySpec,
    preloadedProtos,
  };
}
