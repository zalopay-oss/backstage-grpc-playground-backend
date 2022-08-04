import { PluginDatabaseManager } from "@backstage/backend-common";
import { Config } from "@backstage/config";
import { Logger } from "winston";
import { DatabaseCertStore } from "./DatabaseCertStore";
import { MemoryCertStore } from "./MemoryStore";
import { CertStore } from "./types";

interface Options {
  logger: Logger;
  database: PluginDatabaseManager;
}

export class CertStores {
  static async fromConfig(
    config: Config,
    options: Options
  ): Promise<CertStore | undefined> {
    const { database } = options;
    const certStore = config.getOptionalConfig('grpcPlayground.certStore');

    if (!certStore || !certStore.getOptionalBoolean('enabled')) {
      return undefined;
    }

    const provider = certStore.getOptionalString('provider') ?? 'database';
    const secretKey = certStore.getOptionalString('secretKey') ?? 'qwertyuiopasdfghjklzxcvbnm123456'; // 32 chars
    const initVector = certStore.getOptionalString('initVector') ?? '1234567890123456'; // 16 chars

    if (provider === 'database') {
      if (!database) {
        throw new Error('This CertStore provider requires a database');
      }

      return await DatabaseCertStore.create({
        database: await database.getClient(),
        secretKey,
        initVector,
      });
    }

    if (provider === 'memory') {
      return new MemoryCertStore({
        secretKey,
        initVector,
      });
    }

    throw new Error(`Unknown cert store provider: ${provider}`);
  }
}