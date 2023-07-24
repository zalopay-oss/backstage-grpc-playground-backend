import { resolve as resolvePath } from 'path';
import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import { resolvePackagePath } from '@backstage/backend-common';

import { CertStore, Encoder } from './types';
import { DefaultEncoder } from './encrypt';

import { CertFile, Certificate, CertType } from '../../api';

const packageName = 'backstage-grpc-playground-backend-new';

// Manual resolve package path
function manualResolvePackagePath(name: string, ...paths: string[]) {
  const req =
    typeof __non_webpack_require__ === 'undefined'
      ? require
      : __non_webpack_require__;

  return resolvePath(req.resolve(`${name}/package.json`), '..', ...paths);
}

let migrationsDir: string;

try {
  migrationsDir = resolvePackagePath(packageName, 'migrations');
} catch (err) {
  migrationsDir = manualResolvePackagePath(packageName, 'migrations');
}

const TABLE_CERTIFICATES = 'entity_certificates';
const TABLE_CERTIFICATE_FILES = 'certificate_files';

type CertificateRow = {
  id: string;
  created_at: Date;
  entity_name: string;
  use_server_certificate: boolean;
}

type CertificateFileRow = {
  certificate_id: string;
  created_at: Date;
  file_content?: string;
  file_path?: string;
  file_name: string;
  type: CertType;
}

type Options = {
  database: Knex;
  secretKey: string;
  initVector: string;
}

export class DatabaseCertStore implements CertStore {
  private database: Knex;
  private encoder: Encoder;

  private constructor(options: Options) {
    this.database = options.database;
    this.encoder = DefaultEncoder.fromConfig(options);
  }

  static async create(options: Options) {
    const { database } = options;

    await database.migrate.latest({
      directory: migrationsDir,
    });

    return new DatabaseCertStore(options);
  }

  private async toDBCertFile(cert: CertFile) {
    const { fileName, content, filePath, type } = cert;

    const result: Partial<CertificateFileRow> = {
      file_name: fileName,
      file_path: filePath,
      type,
    };

    if (content) {
      const encodedContent = this.encoder.encode(content);

      result.file_content = encodedContent;
    }

    return result;
  }

  private async insertCertFile(certificateId: string, cert: CertFile) {
    const insertObj: Partial<CertificateFileRow> = {
      certificate_id: certificateId,
      ...await this.toDBCertFile(cert),
      created_at: new Date(),
    };

    return this.database<CertificateFileRow>(TABLE_CERTIFICATE_FILES)
      .insert(insertObj);
  }

  async getCertificate(id: string): Promise<Certificate | undefined> {
    const certFilesWithCertificateId = await this.database<CertificateRow>(TABLE_CERTIFICATES)
      .where('id', id)
      .select('id')
      .innerJoin<CertificateFileRow>(TABLE_CERTIFICATE_FILES, {
        [`${TABLE_CERTIFICATES}.id`]: `${TABLE_CERTIFICATE_FILES}.certificate_id`,
      })
      .select('file_name', 'file_path', 'type');

    const dictById = certFilesWithCertificateId.reduce((dict, { id: certId, file_name, type, file_path }) => {
      if (!dict[certId]) {
        dict[certId] = {} as Certificate;
      }

      dict[certId][type] = {
        fileName: file_name,
        filePath: file_path,
        type,
      } as CertFile;

      return dict;
    }, {} as Record<string, Certificate>);

    return dictById[id];
  }

  async getCertFile(id: string, certType: CertType): Promise<CertFile | undefined> {
    const certificate = await this.database<CertificateFileRow>(TABLE_CERTIFICATE_FILES)
      .where('certificate_id', id)
      .andWhere('type', certType)
      .select('*')
      .first();

    if (!certificate) {
      return undefined;
    }

    const { file_name: fileName, file_content: content, file_path: filePath = '', type } = certificate;

    return {
      type,
      fileName,
      filePath,
      content: content ? this.encoder.decode(content) : undefined,
    }
  }

  async insertCertificateIfNeeded(entityName: string, rootCert: CertFile): Promise<string> {
    const existingCertificate = await this.database<CertificateRow>(TABLE_CERTIFICATES)
      .where('entity_name', entityName)
      .select('id')
      .innerJoin<CertificateFileRow>(TABLE_CERTIFICATE_FILES, {
        [`${TABLE_CERTIFICATES}.id`]: `${TABLE_CERTIFICATE_FILES}.certificate_id`,
      })
      .where('file_path', rootCert.filePath)
      .first();

    if (existingCertificate) {
      await this.updateCertificate(existingCertificate.id, rootCert);

      return existingCertificate.id;
    }

    const id = uuid();
    const creationTime = new Date();

    await this.database<CertificateRow>(TABLE_CERTIFICATES)
      .insert({
        id,
        entity_name: entityName,
        created_at: creationTime,
      });

    await this.insertCertFile(id, rootCert);

    return id;
  }

  async updateCertificate(id: string, cert: CertFile): Promise<void> {
    const now = new Date();
    const newCert: Partial<CertificateFileRow> = {
      certificate_id: id,
      ...await this.toDBCertFile(cert),
    };

    // If the cert file is already present, update it
    // "upsert" action with knex
    await this.database<CertificateFileRow>(TABLE_CERTIFICATE_FILES)
      .insert({
        ...newCert,
        created_at: now,
      })
      .onConflict(['certificate_id', 'type'])
      .merge(['file_content', 'file_name', 'file_path']);
  }

  async deleteCertificate(id: string): Promise<void> {
    const deleted = await this.database<CertificateRow>(TABLE_CERTIFICATES)
      .where('id', id)
      .delete();

    if (deleted) {
      await this.database<CertificateFileRow>(TABLE_CERTIFICATE_FILES)
        .where('certificate_id', id)
        .delete();
    }
  }

  async listCertificates(entityName: string): Promise<Certificate[]> {
    const certFilesWithCertificateId = await this.database<CertificateRow>(TABLE_CERTIFICATES)
      .where('entity_name', entityName)
      .select('id')
      .innerJoin<CertificateFileRow>(TABLE_CERTIFICATE_FILES, {
        [`${TABLE_CERTIFICATES}.id`]: `${TABLE_CERTIFICATE_FILES}.certificate_id`,
      })
      .select('file_name', 'file_path', 'type');

    const dictById = certFilesWithCertificateId.reduce((dict, { id, file_name, type, file_path }) => {
      if (!dict[id]) {
        dict[id] = {} as Certificate;
      }

      dict[id][type] = {
        fileName: file_name,
        filePath: file_path,
        type,
      } as CertFile;

      return dict;
    }, {} as Record<string, Certificate>);

    return Object.keys(dictById).map((id: string): Certificate => ({
      id,
      ...dictById[id],
    }));
  }
}