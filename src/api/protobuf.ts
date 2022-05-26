import { Proto, ServiceMethodsPayload } from './bloomrpc-mock';
import { Service } from 'protobufjs';

export interface ProtoFile {
  proto: Proto;
  fileName: string;
  importPaths?: string[];
  services: ProtoServiceList;
}

export interface ProtoServiceList {
  [key: string]: ProtoService,
}

export interface ProtoService {
  proto: Proto,
  serviceName: string,
  methodsMocks: ServiceMethodsPayload,
  methodsName: string[],
  definition: Service;
}
