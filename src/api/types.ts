export interface Certificate {
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

export interface CertFile extends BaseFile {}

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
}
