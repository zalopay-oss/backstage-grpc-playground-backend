/* eslint-disable no-param-reassign */
import { EventEmitter } from "events";
import { ProtoInfo } from './protoInfo';
import {
  Client, credentials, Metadata, ServiceClientConstructor, ServiceError,
  ClientUnaryCall, CallOptions,
} from '@grpc/grpc-js';
import fs from "fs";
import { Certificate } from "./types";
import { getLogger } from "../service/utils";

interface ServiceClient extends Client {
  [methodName: string]: Function;
}

interface GRPCCall extends ClientUnaryCall {
  write(chunk: any, cb?: Function): boolean;
  end(): void;
}

interface GRPCCaller<RequestType = any, ResponseType = any> {
  (argument: RequestType, metadata: Metadata, options: CallOptions, callback: (err: ServiceError, response: ResponseType) => void): GRPCCall;
  (metadata: Metadata, options: CallOptions, callback: (err: ServiceError, response: ResponseType) => void): GRPCCall;
}

export interface GRPCEventEmitter extends EventEmitter {
  protoInfo: ProtoInfo;
  send(): GRPCEventEmitter;
  write(data: string): GRPCEventEmitter;
  commitStream(): void;
  cancel(): void;
}

export interface GRPCRequestInfo {
  url: string;
  protoInfo: ProtoInfo;
  requestData: ClientRequestInfo;
  interactive?: boolean;
  tlsCertificate?: Certificate;
}

export interface ResponseMetaInformation {
  responseTime?: number;
  stream?: boolean;
}

export const GRPCEventType = {
  DATA: "DATA",
  ERROR: "ERROR",
  END: "END",
};

export type ClientRequestInfo = {
  inputs: Record<string, unknown>;
  metadata: Record<string, string>;
}

export class GRPCRequest extends EventEmitter {
  url: string;
  protoInfo: ProtoInfo;
  requestData: ClientRequestInfo;
  interactive?: boolean;
  tlsCertificate?: Certificate;
  // _call?: ClientUnaryCall | ClientReadableStream<any> | ClientWritableStream<any>;
  _call?: GRPCCall;
  isUnary: boolean = false;
  isClientStreaming: boolean = false;
  isServerStreaming: boolean = false;

  constructor({ url, protoInfo, requestData, interactive, tlsCertificate }: GRPCRequestInfo) {
    super();
    this.url = url;
    this.protoInfo = protoInfo;
    this.requestData = requestData;
    this.interactive = interactive;
    this.tlsCertificate = tlsCertificate;
    this._call = undefined;

    const methodDefinition = this.protoInfo.methodDef();

    if (methodDefinition.requestStream) {
      this.isClientStreaming = true;
    } else {
      this.isUnary = true;
    }

    if (methodDefinition.responseStream) {
      this.isServerStreaming = true;
    }
  }

  send(): GRPCRequest {
    const serviceClient = this.protoInfo.client();
    const client: ServiceClient = this.getClient(serviceClient);
    const { inputs, metadata } = this.requestData;

    // Add metadata
    const md = new Metadata();
    Object.keys(metadata).forEach(key => {
      if (key.endsWith("-bin")) {
        let encoding = "utf8";
        let value = metadata[key];

        // can prefix the value with any encoding that the buffer supports
        // example:
        // binary://binaryvalue
        // utf8://anyvalue
        // base64://sombase64value
        const regexEncoding = /(^.*):\/\/(.*)/g;
        if (regexEncoding.test(value)) {
          const groups = new RegExp(regexEncoding).exec(value);

          if (groups) {
            encoding = groups[1];
            value = groups[2];
          }
        }

        md.add(key, Buffer.from(value, encoding as any));
      } else {
        md.add(key, metadata[key]);
      }
    });

    // Gather method information
    const methodDefinition = this.protoInfo.methodDef();

    let call: GRPCCall;
    const requestStartTime = new Date();

    const method: GRPCCaller = client[this.protoInfo.methodName].bind(client);

    if (methodDefinition.requestStream) {
      // Client side streaming
      call = this.clientSideStreaming(method, inputs, md, requestStartTime);
    } else {
      // Unary call
      call = this.unaryCall(method, inputs, md, requestStartTime);
    }

    // Server Streaming.
    if (methodDefinition.responseStream) {
      this.handleServerStreaming(call, requestStartTime);
    }

    this._call = call;

    this.on(GRPCEventType.END, () => {
      client.close();
    });

    return this;
  }

  /**
   * Write to a stream
   * @param data
   */
  write(data: string) {
    if (this._call) {
      // Add metadata
      let inputs = {};

      try {
        const reqInfo = this.parseRequestInfo(data);
        inputs = reqInfo.inputs;
      } catch (e) {
        return this;
      }

      this._call.write(inputs);
    }
    return this;
  }

  /**
   * Cancel request
   */
  cancel() {
    if (this._call) {
      this._call.cancel();
      this.emit(GRPCEventType.END);
    }
  }

  /**
   * Commit stream
   */
  commitStream() {
    if (this._call) {
      this._call.end();
    }
  }

  /**
   * Get grpc client for this relevant request
   * @param ServiceClient
   */
  private getClient(ServiceClient: ServiceClientConstructor): ServiceClient {
    let creds = credentials.createInsecure();
    let options = {};

    if (this.tlsCertificate) {
      if (this.tlsCertificate.sslTargetHost) {
        options = {
          ...options,
          'grpc.ssl_target_name_override': this.tlsCertificate.sslTargetHost,
          'grpc.default_authority': this.tlsCertificate.sslTargetHost,
        }
      }
      if (this.tlsCertificate.useServerCertificate === true) {
        creds = credentials.createSsl();
      } else {
        creds = credentials.createSsl(
          fs.readFileSync(this.tlsCertificate.rootCert.filePath),
          this.tlsCertificate.privateKey && fs.readFileSync(this.tlsCertificate.privateKey.filePath),
          this.tlsCertificate.certChain && fs.readFileSync(this.tlsCertificate.certChain.filePath),
        );
      }
    }

    return new ServiceClient(this.url, creds, options);
  }

  /**
   * Issue a client side streaming request
   * @param client
   * @param inputs
   * @param md
   * @param requestStartTime
   */
  private clientSideStreaming(method: GRPCCaller, inputs: any, md: Metadata, requestStartTime?: Date): GRPCCall {
    const call = method(md, { deadline: this.getRPCDeadline() }, (err: ServiceError, response: any) => {
      this.handleUnaryResponse(err, response, requestStartTime);
    });

    if (inputs && Array.isArray(inputs.stream)) {
      inputs.stream.forEach((data: object) => {
        call.write(data);
      });
    } else {
      call.write(inputs);
    }

    call.end();

    return call;
  }

  private getRPCDeadline(rpcType = 1) {
    const logger = getLogger();
    let timeAllowed = 5000;

    switch (rpcType) {
      case 1:
        timeAllowed = 5000  // LIGHT RPC
        break

      case 2:
        timeAllowed = 7000  // HEAVY RPC
        break

      default:
        logger.error("Invalid RPC Type: Using Default Timeout")
    }

    return new Date(Date.now() + timeAllowed)
  }

  /**
   * Handle server side streaming response
   * @param call
   * @param streamStartTime
   */
  private handleServerStreaming(call: GRPCCall, streamStartTime?: Date) {
    const logger = getLogger();

    call.on('data', (data: object) => {
      const responseMetaInformation = this.responseMetaInformation(streamStartTime, true);
      this.emit(GRPCEventType.DATA, data, responseMetaInformation);
      streamStartTime = new Date();
    });

    call.on('error', (err: { [key: string]: any }) => {
      const responseMetaInformation = this.responseMetaInformation(streamStartTime, true);
      if (err && err.code !== 1) {
        this.emit(GRPCEventType.ERROR, err, responseMetaInformation);

        if (err.code === 2 || err.code === 14) { // Stream Removed.
          this.emit(GRPCEventType.END, call);
        }
      }
      streamStartTime = new Date();
    });

    call.on('end', () => {
      logger.info('call on end');
      this.emit(GRPCEventType.END, this);
    });
  }

  /**
   * Send a unary call
   * @param client
   * @param inputs
   * @param md
   * @param requestStartTime
   */
  private unaryCall(method: GRPCCaller, inputs: any, md: Metadata, requestStartTime?: Date): GRPCCall {
    return method(inputs, md, { deadline: this.getRPCDeadline() }, (err: ServiceError, response: any) => {
      this.handleUnaryResponse(err, response, requestStartTime);
    });
  }

  /**
   * Handle unary response
   * @param err
   * @param response
   * @param requestStartTime
   */
  private handleUnaryResponse(err: ServiceError, response: any, requestStartTime?: Date) {
    const responseMetaInformation = this.responseMetaInformation(requestStartTime);

    // Client side streaming handler
    if (err) {
      // Request cancelled do nothing
      if (err.code === 1) {
        return;
      }

      this.emit(GRPCEventType.ERROR, err, responseMetaInformation);

    } else {
      this.emit(GRPCEventType.DATA, response, responseMetaInformation);
    }
    this.emit(GRPCEventType.END);
  }

  /**
   * Response meta information
   * @param startTime
   * @param stream
   */
  private responseMetaInformation(startTime?: Date, stream?: boolean) {
    const responseDate = new Date();

    return {
      responseTime: startTime && (responseDate.getTime() - startTime.getTime()) / 1000,
      stream,
    };
  }

  /**
   * Parse JSON to request inputs / metadata
   * @param data
   * @param userMetadata
   */
  private parseRequestInfo(data: string, userMetadata?: string): { inputs: object, metadata: object } {
    let inputs = {};
    let metadata: { [key: string]: any } = {};

    try {
      inputs = JSON.parse(data || "{}")
    } catch (e) {
      e.message = "Couldn't parse JSON inputs Invalid json";
      this.emit(GRPCEventType.ERROR, e, {});
      this.emit(GRPCEventType.END);
      throw new Error(e);
    }

    if (userMetadata) {
      try {
        metadata = JSON.parse(userMetadata || "{}")
      } catch (e) {
        e.message = "Couldn't parse JSON metadata Invalid json";
        this.emit(GRPCEventType.ERROR, e, {});
        this.emit(GRPCEventType.END);
        throw new Error(e);
      }
    }

    return { inputs, metadata };
  }
}
