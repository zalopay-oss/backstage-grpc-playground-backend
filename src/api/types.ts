import { LoadCertStatus } from "../service/utils";

export interface Certificate {
  id?: string;
  rootCert: CertFile;
  privateKey?: CertFile;
  certChain?: CertFile;
  sslTargetHost?: string;
  useServerCertificate?: boolean;
}

export interface BaseFile {
  fileName: string;
  filePath: string;
}

export type CertType = 'rootCert' | 'privateKey' | 'certChain';

export interface CertFile extends BaseFile {
  type: CertType;
  content?: string;
}

export interface FileWithImports extends BaseFile {
  imports?: PlaceholderFile[];
  missing?: PlaceholderFile[];
}

export interface PlaceholderFile extends FileWithImports {
  isPreloaded?: boolean;
  url?: string;
}

export interface WritableFile extends PlaceholderFile {
  content?: string;
  imports?: WritableFile[];
}

export interface Library {
  isPreloaded?: boolean;
  version?: string;
  url?: string;
  name: string;
  path?: string;
}

export interface GRPCTarget {
  [key: string]: GRPCTargetInfo;
}

export interface GRPCTargetInfo {
  host?: string;
  port?: number;
}

export interface BaseEntitySpec {
  targets: GRPCTarget;
}

export interface EntitySpec extends BaseEntitySpec {
  files: PlaceholderFile[];
  imports?: PlaceholderFile[];
  libraries?: Library[];
}

export type LoadCertResult = {
  certs?: CertFile[];
  status?: LoadCertStatus;
  missingCerts?: Partial<CertFile>[];
  message?: string;
  certificate?: Certificate;
};