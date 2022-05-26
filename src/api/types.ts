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

export interface CertFile extends BaseFile {
  fileName: string;
  filePath: string;
}

export interface FileWithImports extends BaseFile {
  importPaths?: string[];
}

export interface RawPlaceholderFile {
  file_name: string;
  file_path: string;
  is_preloaded?: boolean;
  import_paths?: string[];
  url?: string;
  is_library: boolean;
}

export interface PlaceholderFile extends FileWithImports {
  isPreloaded?: boolean;
  url?: string;
  isLibrary?: boolean;
}

export interface WritableFile extends BaseFile {
  content: string;
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

export interface RawEntitySpec extends BaseEntitySpec {
  definition: string;
  files: RawPlaceholderFile[];
  imports?: RawPlaceholderFile[];
}

export interface EntitySpec extends BaseEntitySpec {
  files: PlaceholderFile[];
  imports?: PlaceholderFile[];
}
