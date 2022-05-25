export interface Certificate {
  rootCert: CertFile;
  privateKey?: CertFile;
  certChain?: CertFile;
  sslTargetHost?: string;
  useServerCertificate?: boolean;
}

export interface CertFile {
  fileName: string;
  filePath: string;
}

export interface RawPlaceholderFile {
  file_name: string;
  file_path: string;
  is_preloaded?: boolean;
  import_paths?: string[];
  url?: string;
  is_library: boolean;
}

export interface PlaceholderFile {
  fileName: string;
  filePath: string;
  isPreloaded?: boolean;
  importPaths?: string[];
  url?: string;
  isLibrary?: boolean;
}

export interface PreloadedFile {
  fileName: string;
  filePath: string;
  importPaths?: string[];
}

export interface WritableFile {
  fileName: string;
  filePath: string;
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

export interface MissingImportFile {
  fileName: string;
  filePath: string;
}
