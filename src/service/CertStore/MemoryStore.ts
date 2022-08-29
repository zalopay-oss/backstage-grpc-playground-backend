import { CertFile, Certificate, CertType } from "../../api";
import { CertStore, Encoder } from "./types";
import { v4 as uuid } from 'uuid';
import { DefaultEncoder } from "./encrypt";
import { pick } from "lodash";

type CertificateRow = Certificate & {
  createdAt: Date;
  entityName: string;
}

type CertificateFileRow = CertFile & {
  certificateId: string;
  createdAt: Date;
}

type Options = {
  secretKey: string;
  initVector: string;
}

export class MemoryCertStore implements CertStore {
  private readonly encoder: Encoder;

  // Databases
  private readonly certificatesById: { [id: string]: CertificateRow } = {};
  private readonly certificatesByEntity: { [entityName: string]: string[] } = {};

  constructor(options: Options) {
    this.encoder = DefaultEncoder.fromConfig(options);
  }

  async insertCertificateIfNeeded(entityName: string, rootCert: CertFile): Promise<string> {
    const entityCertificates = this.getEntityCertificates(entityName)

    const existingCertificate = entityCertificates.find(cert => cert.rootCert.filePath === rootCert.filePath);

    if (existingCertificate?.id) {
      this.updateCertificate(existingCertificate.id, rootCert);

      return existingCertificate.id;
    }

    return this.insertCertificate(entityName, rootCert);
  }

  async updateCertificate(id: string, cert: CertFile): Promise<void> {
    const certificate = this.certificatesById[id];

    if (certificate) {
      const now = new Date();
      const newCertFile: CertificateFileRow = {
        ...this.toDBCertFile(cert),
        certificateId: id,
        createdAt: now,
      };

      certificate[cert.type] = newCertFile;
    }
  }

  async deleteCertificate(id: string): Promise<void> {
    delete this.certificatesById[id];

    for (const entityCerts of Object.keys(this.certificatesByEntity)) {
      if (this.certificatesByEntity[entityCerts].includes(id)) {
        this.certificatesByEntity[entityCerts] = this.certificatesByEntity[entityCerts].filter(certId => certId !== id);
      }
    }
  }

  async listCertificates(entityName: string): Promise<Certificate[]> {
    return this.getEntityCertificates(entityName).map(this.toDTO.bind(this));
  }

  async getCertificate(id: string): Promise<Certificate | undefined> {
    return this.certificatesById[id] ? this.toDTO(this.certificatesById[id]) : undefined;
  }

  async getCertFile(id: string, certType: CertType): Promise<CertFile | undefined> {
    const certificate = this.certificatesById[id];

    if (!certificate) return undefined;

    const certFile = certificate[certType];

    return certFile ? {
      ...certFile,
      content: certFile.content ? this.encoder.decode(certFile.content) : undefined,
    } : undefined;
  }

  //
  // HELPERS
  //
  private initEntityCertificatesIfNeeded(entityName: string): void {
    this.certificatesByEntity[entityName] = this.certificatesByEntity[entityName] || [];
  }

  private getEntityCertificates(entityName: string): CertificateRow[] {
    this.initEntityCertificatesIfNeeded(entityName);
    const certificateIdsByEntity = this.certificatesByEntity[entityName];

    return certificateIdsByEntity.map(id => this.certificatesById[id]);
  }

  private insertCertificate(entityName: string, pRootCert: CertFile): string {
    const now = new Date();
    const certificateId = uuid();

    const rootCert: CertificateFileRow = {
      ...this.toDBCertFile(pRootCert),
      certificateId,
      createdAt: now,
    }

    const certificate: CertificateRow = {
      id: certificateId,
      createdAt: now,
      entityName,
      rootCert,
    }

    this.certificatesById[certificateId] = certificate;
    this.initEntityCertificatesIfNeeded(certificate.entityName);
    this.certificatesByEntity[certificate.entityName].push(certificateId);

    return certificateId;
  }

  private toDBCertFile(cert: CertFile) {
    const { fileName, content, filePath, type } = cert;

    const result: CertFile = {
      fileName,
      filePath,
      type,
    };

    if (content) {
      const encodedContent = this.encoder.encode(content);
      result.content = encodedContent;
    }

    return result;
  }

  private toDTO(certificate: CertificateRow): Certificate {
    return {
      id: certificate.id,
      rootCert: this.toDTOCertFile(certificate.rootCert),
      privateKey: certificate.privateKey ? this.toDTOCertFile(certificate.privateKey) : undefined,
      certChain: certificate.certChain ? this.toDTOCertFile(certificate.certChain) : undefined,
      useServerCertificate: certificate.useServerCertificate,
      sslTargetHost: certificate.sslTargetHost,
    }
  }

  private toDTOCertFile(certFile: CertFile): CertFile {
    return pick(certFile, 'fileName', 'filePath', 'type');
  }
}