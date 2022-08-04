import { CertFile, Certificate, CertType } from "../../api";

export interface CertStore {
  insertCertificateIfNeeded(entityName: string, rootCert: CertFile): Promise<string>;
  updateCertificate(id: string, cert: CertFile): Promise<void>;
  deleteCertificate(id: string): Promise<void>;
  listCertificates(entityName: string): Promise<Certificate[]>;
  getCertificate(id: string): Promise<Certificate | undefined>;
  getCertFile(id: string, certType: CertType): Promise<CertFile | undefined>;
}

export interface Encoder {
  encode(data: string): string;
  decode(encoded: string): string;
}