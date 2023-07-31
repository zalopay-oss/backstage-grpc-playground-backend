import { CacheClient, errorHandler, PluginDatabaseManager, UrlReader } from '@backstage/backend-common';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import { PlaceholderResolver } from '@backstage/plugin-catalog-backend';
import { partial, uniqBy } from 'lodash';
import { ScmIntegrations } from '@backstage/integration';

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
  LoadCertResult,
  CertFile,
  Certificate,
} from './../api';

import {
  LoadProtoStatus,
  getProtoInput,
  sendRequestInput,
  getProtoUploadPath,
  validateRequestBody,
  getAbsolutePath,
  getFileNameFromPath,
  REPO_URL,
  setLogger,
  getRelativePath,
  resolveRelativePath,
  LoadCertStatus
} from './utils';
import { GenDocConfig, GenDocConfigWithCache, installDocGenerator, isInstalledProtocGenDoc } from '../api/docGenerator';
import { JsonValue } from '@backstage/types';
import { CertStore } from './CertStore';

export interface RouterOptions {
  logger: Logger;
  reader: UrlReader;
  config?: JsonValue;
  certStore?: CertStore;
  cacheClient?: CacheClient;
  database: PluginDatabaseManager;
  integrations: ScmIntegrations;
}

const getTime = () => new Date().toLocaleTimeString();

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, reader, certStore, integrations, config, cacheClient } = options;

  setLogger(logger);
  logger.info(`Creating router grpc-playground with certStore enabled: ${!!certStore}`);

  const router = Router();
  router.use(express.json());

  const placeholderResolvers: Record<string, PlaceholderResolver> = {
    text: textPlaceholderResolver,
  };

  const placeholderProcessor = new CustomPlaceholderProcessor({
    resolvers: placeholderResolvers,
    reader,
    integrations,
    logger,
  });

  const genDocConfig = (config as any)?.document as GenDocConfig | undefined;

  if (genDocConfig) {
    const { protocGenDoc, useCache } = genDocConfig;
    const { install, version } = protocGenDoc || {}

    if (install && version) {
      if (useCache?.enabled) {
        (genDocConfig as GenDocConfigWithCache).cacheClient = cacheClient;
      }

      if (!isInstalledProtocGenDoc()) {
        try {
          await installDocGenerator(version);
        } catch (err) {
          logger.error(`Error installing protoc-gen-doc. Please submit a new issue at ${REPO_URL}`, err);
        }
      }
    }
  }

  router.get('/health', (_, response) => {
    logger.info('PONG!');
    response.send({ status: 'ok' });
  });

  router.get('/certificates/:entity', async (req, res) => {
    const { entity: entityName } = req.params;

    if (!certStore) {
      res.status(400).send({
        status: LoadCertStatus.fail,
        message: 'Certificate store not configured'
      });
      return;
    }

    const certificates = await certStore.listCertificates(entityName);

    res.send(certificates);
  });

  router.post('/proto-info/:entity', async (req, res) => {
    const { entitySpec: fullSpec, isGenDoc } = await validateRequestBody(
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
    const { entitySpec, preloadedProtos } = parseEntitySpec(fullSpec as EntitySpec);

    // Stage 1: Load from local storage
    if (preloadedProtos?.length) {
      const { protos, status, missingImports } = await loadProtos(
        UPLOAD_PATH,
        preloadedProtos,
        { ...genDocConfig, enabled: !!isGenDoc },
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
        const { files: protoFiles, imports: commonImports, libraries } = getProtoData;

        const filesToLoad: FileWithImports[] = protoFiles.map(f => ({
          ...f,
          imports: commonImports.concat((f.imports || []).flat()).concat(libraries),
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
        } = await loadProtos(UPLOAD_PATH, filesToLoad, genDocConfig);

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

  router.get('/proto-text/:entity', async (req, res) => {
    const { entity: entityName } = req.params;
    const filePath = req.query.filePath as string | undefined;

    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({
        status: LoadProtoStatus.fail,
        message: 'Must provide file path'
      });
      return;
    }

    if (typeof filePath !== 'string') {
      res.status(400).json({
        status: LoadProtoStatus.fail,
        message: 'filePath must be a valid string'
      });
      return;
    }

    const UPLOAD_PATH = getProtoUploadPath(entityName);
    const absoluteFilePath = getAbsolutePath(
      UPLOAD_PATH,
      filePath,
    );

    if (!fs.existsSync(absoluteFilePath)) {
      res.status(400).json({
        status: LoadProtoStatus.fail,
        message: 'Not found'
      });
      return;
    }

    const protoText = fs.readFileSync(absoluteFilePath, 'utf-8');

    res.json({
      status: LoadProtoStatus.ok,
      protoText
    });
  })

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
              logger.warn('Error setup storage', err);
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

        let isGenDoc = req.body.isGenDoc;

        try {
          isGenDoc = JSON.parse(isGenDoc);
        } catch (err) {
          // Ignore
          isGenDoc = false;
        }

        const loadProtoResult = await loadProtos(UPLOAD_PATH, filesWithImports, { ...genDocConfig, enabled: isGenDoc });
        res.send(loadProtoResult);
        return;
      }

      res.send({
        status: LoadProtoStatus.fail,
        message: 'Empty files',
      });
    });
  });

  router.post('/upload-cert/:entity', async (req, res) => {
    const { entity: entityName } = req.params;
    const CERT_PATH = getProtoUploadPath(entityName, 'certs');
    const pGetRelativePath = partial(getRelativePath, CERT_PATH);

    const storage = multer.diskStorage({
      destination: function (_req, _file, callback) {
        if (!fs.existsSync(CERT_PATH)) {
          fs.mkdirSync(CERT_PATH, {
            recursive: true,
          });
        }

        callback(null, CERT_PATH);
      },

      filename: function (_req, file, callback) {
        const fileName = file.originalname;
        callback(null, fileName);
      },
    });

    const upload = multer({ storage });

    upload.array('files[]', 10)(req, res, async () => {
      if (req.files?.length) {
        const files = req.files as Express.Multer.File[];
        const returnFiles: CertFile[] = [];

        let certificate!: Certificate;
        let rootCert: CertFile | undefined;

        if (req.body.certificate) {
          try {
            certificate = JSON.parse(req.body.certificate);
          } catch (err) {
            // ignore
          }
        }

        try {
          certificate = {
            ...(certificate || {}),
          } as Certificate;
        } catch (err) {
          logger.warn(`Error setting up certificate ${err}`);
        }

        for (const file of files) {
          let returnFile: CertFile | undefined;

          if (req.body.fileMappings) {
            let fileMappings;

            try {
              fileMappings = JSON.parse(req.body.fileMappings) as Record<string, CertFile>;

              if (fileMappings[file.filename]) {
                if (fileMappings[file.filename].type === 'rootCert') {
                  rootCert = fileMappings[file.filename];
                }

                returnFile = {
                  fileName: file.filename,
                  filePath: pGetRelativePath(file.path),
                  type: fileMappings[file.filename].type,
                };
              }
            } catch (err) {
              logger.warn('Error setup storage', err);
            }
          }

          if (returnFile) {
            returnFiles.push(returnFile);

            if (certStore) {
              // Save to certStore for restoring purpose
              const fileContent = fs.readFileSync(file.path).toString();

              if (rootCert) {
                // Upload root cert mean that we need to create a new certificate
                logger.info(`Creating new certificate if needed for root cert ${rootCert.filePath}`);
                const certId = await certStore.insertCertificateIfNeeded(entityName, {
                  ...rootCert,
                  content: fileContent,
                });

                // Assign id to certificate
                certificate.id = certId;
              }

              // Upload privateKey or certChain require certificate
              if (certificate.id) {
                await certStore.updateCertificate(certificate.id, {
                  ...returnFile,
                  content: fileContent,
                });
              } else {
                logger.warn(`Certificate ${certificate.rootCert?.filePath} is not found in DB`);
              }
            }
          }
        }

        // Finally assign uploaded files to certificate
        returnFiles.forEach(returnFile => {
          certificate![returnFile.type] = returnFile;
        });

        const result: LoadCertResult = {
          status: LoadCertStatus.ok,
          certificate,
          certs: returnFiles,
        }

        res.send(result);
        return;
      }

      res.send({
        status: LoadProtoStatus.fail,
        message: 'Empty files',
      });
    });
  });

  router.delete('/certificates/:entity/:id', async (req, res) => {
    const { entity, id } = req.params;

    if (!certStore) {
      res.status(400).send({
        status: LoadCertStatus.fail,
        message: 'Certificate store not configured'
      });
      return;
    }

    let ok = false;
    let message = '';

    const certificate = await certStore.getCertificate(id);
    const CERT_PATH = getProtoUploadPath(entity, 'certs');

    try {
      if (certificate) {
        const pGetAbsolutePath = partial(getAbsolutePath, CERT_PATH);

        await certStore.deleteCertificate(id);

        for (const certFile of [certificate.rootCert, certificate.privateKey, certificate.certChain]) {
          const filePath = certFile?.filePath ? pGetAbsolutePath(certFile?.filePath) : '';

          if (filePath && fs.existsSync(filePath)) {
            fs.rmSync(pGetAbsolutePath(filePath));
          }
        }

        ok = true;
      } else {
        message = 'Certificate not found';
      }
    } catch (err) {
      message = err?.message || 'Unknown error';
    }

    res.send({
      ok,
      message,
    });
  });

  router.post('/send-request/:entity', async (req, res) => {
    const clientRequest = await validateRequestBody(req, sendRequestInput);
    const { entity: entityName } = req.params;

    const UPLOAD_PATH = getProtoUploadPath(entityName);
    const CERT_PATH = getProtoUploadPath(entityName, 'certs');

    const {
      proto: protoPath,
      methodName,
      imports,
      serviceName,
      url,
      requestData,
      interactive,
      tlsCertificate,
    } = clientRequest;

    const filesWithImports: FileWithImports[] = [
      {
        fileName: getFileNameFromPath(protoPath),
        filePath: protoPath,
        imports,
      },
    ];

    const loadProtoResult = await loadProtos(UPLOAD_PATH, filesWithImports, genDocConfig);

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

    const trueTlsCertificate = tlsCertificate ? { ...tlsCertificate } as Certificate : undefined;

    if (tlsCertificate) {
      const missingCerts: NonNullable<LoadCertResult['missingCerts']> = [];
      const pGetAbsolutePath = partial(getAbsolutePath, CERT_PATH);

      // Get full certfile path and check if it exists
      // If not, try to use db to recover it
      // If can not recover, we say that the certfile is missing
      // eslint-disable-next-line no-inner-declarations
      async function ensureCertFile(cert: CertFile) {
        const type = cert.type;

        trueTlsCertificate![type] = {
          fileName: cert.fileName || '',
          filePath: pGetAbsolutePath(cert.filePath || ''),
          type,
        }

        if (!fs.existsSync(trueTlsCertificate![type]!.filePath!)) {
          let isMissing = true;

          // Handle err
          if (certStore && trueTlsCertificate?.id) {
            try {
              const certFile = await certStore.getCertFile(trueTlsCertificate!.id, type);

              logger.info(`Found cert ${certFile?.filePath}. File has content?: ${!!certFile?.content}`);

              if (certFile?.content) {
                const absoluteFilePath = trueTlsCertificate![type]!.filePath!;
                logger.info(`Recovering file ${absoluteFilePath}`)

                ensureDirectoryExistence(absoluteFilePath);
                fs.writeFileSync(absoluteFilePath, certFile.content);
                logger.info(`File recovered at ${absoluteFilePath}`);
                isMissing = false;
              }
            } catch (err) {
              logger.warn(`Can not find cert in DB or can not recover. Error ${err}`);
            }
          } else {
            logger.warn(`No certStore or no cert id. Can not recover cert`);
            isMissing = true;
          }

          if (isMissing) {
            missingCerts.push({
              ...cert,
              type,
            });
          }
        } else {
          logger.info(`CertFile exists at ${trueTlsCertificate![type]!.filePath}`);
        }
      }

      if (!tlsCertificate.useServerCertificate) {
        if (tlsCertificate.rootCert) {
          await ensureCertFile(tlsCertificate.rootCert);
        }

        if (tlsCertificate.privateKey) {
          await ensureCertFile(tlsCertificate.privateKey);
        }

        if (tlsCertificate.certChain) {
          await ensureCertFile(tlsCertificate.certChain);
        }
      }

      if (missingCerts.length) {
        const result: LoadCertResult = {
          status: LoadCertStatus.part,
          missingCerts,
          certificate: tlsCertificate,
        }

        res.status(400).json(result);

        return;
      }
    }

    const grpcRequest = new GRPCRequest({
      url,
      requestData,
      protoInfo,
      interactive,
      tlsCertificate: trueTlsCertificate
    });

    const isStreaming =
      grpcRequest.isServerStreaming || grpcRequest.isClientStreaming;

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

    function onError(e: any, metaInfo: ResponseMetaInformation) {
      const chunk = JSON.stringify({
        error: e,
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
      logger.info('Request closed');
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
    libraries: spec.libraries,
    targets: spec.targets as GRPCTarget,
  };

  return {
    entitySpec,
    preloadedProtos,
  };
}
