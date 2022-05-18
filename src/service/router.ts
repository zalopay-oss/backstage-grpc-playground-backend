import { ClientRequestInfo, GRPCEventType, GRPCRequest, ResponseMetaInformation } from './../api/sendRequest';
import { ProtoService } from './../api/protobuf';
import { ProtoInfo } from './../api/protoInfo';
import { Readable, Writable } from 'stream';
// eslint-disable-next-line import/no-extraneous-dependencies
import { v4 as uuid } from 'uuid';
/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { errorHandler, resolvePackagePath } from '@backstage/backend-common';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import multer, { Multer } from 'multer';
import { loadProtos, parseServices } from '../api/importProtos';
import { sendRequestInput, validateRequestBody } from './utils';
import { loadPackageDefinition, Metadata } from '@grpc/grpc-js';
// eslint-disable-next-line import/no-extraneous-dependencies
import { fromJSON } from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import { Proto } from 'bloomrpc-mock';

const storage = multer.diskStorage({
  destination: function (_req, _file, callback) {
    callback(null, resolvePackagePath(
      '@backstage/plugin-bloomrpc-backend',
      'uploads/',
    ));
  },
  filename: function (_req, file, callback) {
    callback(null, file.originalname);
  }
});

// const upload = multer({ dest: 'uploads/' });

const upload = multer({ storage });

export interface RouterOptions {
  logger: Logger;
}

const getTime = () => new Date().toLocaleTimeString();

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger } = options;

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, response) => {
    logger.info('PONG!');
    response.send({ status: 'ok' });
  });

  router.post('/upload-proto', upload.array('files[]', 10), async (req, res) => {

    console.log('files', req.files);

    if (req.files?.length) {
      const filePaths: string[] = [];

      const files = req.files as Express.Multer.File[];

      console.log('upload dir', process.cwd());

      files.forEach((file) => {
        filePaths.push(file.path);
      })
      console.log('OUTPUT ~ files.forEach ~ filePaths', filePaths);

      const protofiles = await loadProtos(filePaths);
      console.log('OUTPUT ~ router.post ~ protofiles', protofiles);
      res.send({ status: 'ok', protos: protofiles });

      return;
    }

    res.send({ status: 'ok' });
  })

  router.post('/send-request', async (req, res) => {
    const clientRequest = await validateRequestBody(req, sendRequestInput);

    const {
      proto: protoText,
      methodName,
      serviceName,
      url,
      requestData,
      interactive
    } = clientRequest;

    const root = parse(protoText).root;
    const ast = loadPackageDefinition(fromJSON(root));

    const proto = {
      ast,
      root,
    } as Proto;

    const services = parseServices(proto);

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
        res.write(`data: ${chunk}\n\n`, (err) => {
          console.log('OUTPUT ~ res.write2 ~ err', err);
        })
      } else {
        res.write(chunk);
      }
    }

    grpcRequest
      .on(GRPCEventType.DATA, onData)
      .on(GRPCEventType.ERROR, onError)
      .on(GRPCEventType.END, onEnd)
      .send();

    // countdown(res, 1, 10);
  });

  router.use(errorHandler());
  return router;
}
