import crypto from 'crypto';
import { Encoder } from "./types";

type Options = {
  secretKey: string; // 32 length string
  initVector: string; // 16 length string
}

export class DefaultEncoder implements Encoder {
  private readonly algorithm = "aes-256-cbc";
  private readonly secretKey: Buffer;
  private readonly initVector: Buffer;

  private constructor(
    secretKey: string,
    initVector: string
  ) {
    if (secretKey.length !== 32) {
      throw new Error('Secret key must be 32 length string');
    }

    if (initVector.length !== 16) {
      throw new Error('Init vector must be 16 length string');
    }

    this.secretKey = Buffer.from(secretKey);
    this.initVector = Buffer.from(initVector);
  }

  static fromConfig(options: Options) {
    const { secretKey, initVector } = options;
    return new DefaultEncoder(secretKey, initVector);
  }

  encode(data: string): string {
    const cipher = crypto.createCipheriv(this.algorithm, this.secretKey, this.initVector);

    // encrypt the message
    let encryptedData = cipher.update(data, "utf-8", "hex");
    encryptedData += cipher.final("hex");

    return encryptedData;
  }

  decode(encoded: string) {
    const decipher = crypto.createDecipheriv(this.algorithm, this.secretKey, this.initVector);

    // decrypt the message
    let decryptedData = decipher.update(encoded, "hex", "utf-8");
    decryptedData += decipher.final("utf8");

    return decryptedData;
  }
}